const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('sales_team'));

// ===== DASHBOARD STATS =====
router.get('/stats', async (req, res) => {
    try {
        const pool = getDb();
        const total = await pool.query("SELECT COUNT(*) as c FROM sales_orders");
        const pending = await pool.query("SELECT COUNT(*) as c FROM sales_orders WHERE status='pending'");
        const approved = await pool.query("SELECT COUNT(*) as c FROM sales_orders WHERE status='approved'");
        const invoiced = await pool.query("SELECT COUNT(*) as c FROM sales_orders WHERE status='invoiced'");
        const paid = await pool.query("SELECT COUNT(*) as c FROM sales_orders WHERE status='paid'");
        const dispatched = await pool.query("SELECT COUNT(*) as c FROM sales_orders WHERE status='dispatched'");
        const delivered = await pool.query("SELECT COUNT(*) as c FROM sales_orders WHERE status='delivered'");
        const totalRevenue = await pool.query("SELECT COALESCE(SUM(total_price),0) as c FROM sales_orders WHERE status IN ('paid','dispatched','delivered')");
        const newOrders = await pool.query("SELECT COUNT(*) as c FROM customer_orders WHERE status='placed'");
        res.json({ stats: { total: parseInt(total.rows[0].c), pending: parseInt(pending.rows[0].c), approved: parseInt(approved.rows[0].c), invoiced: parseInt(invoiced.rows[0].c), paid: parseInt(paid.rows[0].c), dispatched: parseInt(dispatched.rows[0].c), delivered: parseInt(delivered.rows[0].c), total_revenue: parseFloat(totalRevenue.rows[0].c), new_customer_orders: parseInt(newOrders.rows[0].c) } });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch stats' }); }
});

// ===== CUSTOMER ORDERS =====
router.get('/customer-orders', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT co.*, u.name as customer_user_name
            FROM customer_orders co
            LEFT JOIN users u ON co.customer_id = u.id
            ORDER BY co.created_at DESC
        `);

        const soResult = await pool.query("SELECT customer_order_id FROM sales_orders");
        const processedIds = soResult.rows.map(v => v.customer_order_id);
        const orders = result.rows.map(o => { o.has_sales_order = processedIds.includes(o.id); return o; });

        res.json({ orders });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch customer orders' }); }
});

// ===== AI DEMAND FORECAST =====
router.get('/demand-forecast', async (req, res) => {
    try {
        const pool = getDb();
        const demandResult = await pool.query(`
            SELECT product_name,
                   COUNT(*) as order_count,
                   SUM(quantity_kg) as total_kg,
                   SUM(total_price) as total_revenue,
                   AVG(quantity_kg) as avg_order_kg
            FROM customer_orders
            GROUP BY product_name
            ORDER BY SUM(quantity_kg) DESC
        `);

        let products = demandResult.rows.map(obj => {
            const score = Math.min(100, Math.round(
                (parseInt(obj.order_count) * 15) + (parseFloat(obj.total_kg) * 0.5) + (parseFloat(obj.total_revenue) * 0.01)
            ));
            obj.demand_score = score;
            obj.trend = score > 80 ? 'HOT' : score > 50 ? 'GROWING' : score > 25 ? 'STABLE' : 'LOW';
            obj.forecast_next_month = Math.round(parseFloat(obj.total_kg) * 1.15);
            return obj;
        });

        const stockResult = await pool.query(`
            SELECT product_name, SUM(quantity_kg) as available_kg
            FROM warehouse_stocks WHERE status='in_stock'
            GROUP BY product_name
        `);
        const stockMap = {};
        stockResult.rows.forEach(v => { stockMap[v.product_name] = parseFloat(v.available_kg); });
        products.forEach(p => { p.available_stock_kg = stockMap[p.product_name] || 0; });

        res.json({ products, generated_at: new Date().toISOString() });
    } catch (err) { res.status(500).json({ error: 'Failed to generate forecast' }); }
});

// ===== GENERATE SALES ORDER =====
router.post('/generate-order', async (req, res) => {
    try {
        const pool = getDb();
        const { customer_order_id, demand_notes } = req.body;
        if (!customer_order_id) return res.status(400).json({ error: 'Customer order ID required' });

        const co = await pool.query("SELECT * FROM customer_orders WHERE id = $1", [customer_order_id]);
        if (co.rows.length === 0) return res.status(404).json({ error: 'Customer order not found' });
        const order = co.rows[0];

        const existing = await pool.query("SELECT id FROM sales_orders WHERE customer_order_id = $1", [customer_order_id]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Sales order already exists for this customer order' });
        }

        const demandData = await pool.query("SELECT COUNT(*) as cnt, SUM(quantity_kg) as total_kg FROM customer_orders WHERE product_name = $1", [order.product_name]);
        const orderCount = parseInt(demandData.rows[0].cnt) || 1;
        const totalKg = parseFloat(demandData.rows[0].total_kg) || order.quantity_kg;
        const demandScore = Math.min(100, Math.round((orderCount * 15) + (totalKg * 0.5)));

        const unitPrice = order.total_price / order.quantity_kg;
        const notes = demand_notes || `Auto-analyzed: ${orderCount} orders for ${order.product_name}, ${totalKg}kg total demand.`;

        const soResult = await pool.query(
            `INSERT INTO sales_orders (customer_order_id, customer_id, customer_name, customer_phone, customer_address, product_name, quantity_kg, unit_price, total_price, demand_score, demand_notes, sales_person_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') RETURNING id`,
            [customer_order_id, order.customer_id, order.customer_name, order.customer_phone, order.customer_address,
                order.product_name, order.quantity_kg, unitPrice, order.total_price, demandScore, notes, req.user.id]
        );
        const soId = soResult.rows[0].id;

        const io = req.app.get('io');
        if (io) {
            io.to('warehouse_manager').emit('new_sales_order', {
                orderId: soId, product: order.product_name, quantity: order.quantity_kg,
                message: `New sales order #${soId}: ${order.product_name} (${order.quantity_kg}kg) for ${order.customer_name}`
            });
        }

        res.json({ message: `Sales order #${soId} generated and sent to warehouse!`, sales_order_id: soId });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to generate order' }); }
});

// ===== ALL SALES ORDERS =====
router.get('/sales-orders', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT so.*, u.name as sales_person_name,
                   i.invoice_no, i.total_amount as invoice_amount, i.payment_status
            FROM sales_orders so
            LEFT JOIN users u ON so.sales_person_id = u.id
            LEFT JOIN invoices i ON i.sales_order_id = so.id
            ORDER BY so.created_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch sales orders' }); }
});

module.exports = router;
