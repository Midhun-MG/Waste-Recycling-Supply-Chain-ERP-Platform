const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Middleware: allow warehouse_manager, warehouse_driver, and sales_team
function requireWarehouseRole(req, res, next) {
    if (!['warehouse_manager', 'warehouse_driver', 'sales_team'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Warehouse access required' });
    }
    next();
}
router.use(requireWarehouseRole);

// ===== WAREHOUSE MANAGER: Dashboard stats =====
router.get('/stats', async (req, res) => {
    try {
        const pool = getDb();
        const inStock = await pool.query("SELECT COUNT(*) as c FROM warehouse_stocks WHERE status = 'in_stock'");
        const totalKg = await pool.query("SELECT COALESCE(SUM(quantity_kg), 0) as c FROM warehouse_stocks WHERE status = 'in_stock'");
        const incomingTrucks = await pool.query("SELECT COUNT(*) as c FROM warehouse_deliveries WHERE status IN ('pending','picked_up','in_transit')");
        const pendingOrders = await pool.query("SELECT COUNT(*) as c FROM customer_orders WHERE status IN ('placed','confirmed','packing')");
        const deliveredOrders = await pool.query("SELECT COUNT(*) as c FROM customer_orders WHERE status = 'delivered'");
        const totalRevenue = await pool.query("SELECT COALESCE(SUM(total_price), 0) as c FROM customer_orders WHERE status = 'delivered'");

        res.json({
            stats: {
                in_stock: parseInt(inStock.rows[0].c) || 0,
                total_kg: parseFloat(totalKg.rows[0].c) || 0,
                incoming_trucks: parseInt(incomingTrucks.rows[0].c) || 0,
                pending_orders: parseInt(pendingOrders.rows[0].c) || 0,
                delivered_orders: parseInt(deliveredOrders.rows[0].c) || 0,
                total_revenue: parseFloat(totalRevenue.rows[0].c) || 0
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ===== WAREHOUSE STOCKS =====
router.get('/stocks', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query("SELECT * FROM warehouse_stocks ORDER BY created_at DESC");
        res.json({ stocks: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stocks' });
    }
});

// ===== AGGREGATED INVENTORY =====
router.get('/inventory', async (req, res) => {
    try {
        const pool = getDb();

        const aggResult = await pool.query(`
            SELECT product_name,
                   SUM(quantity_kg) as total_kg,
                   COUNT(*) as batch_count,
                   STRING_AGG(DISTINCT batch_no, ',') as batches,
                   STRING_AGG(DISTINCT location, ',') as locations,
                   MIN(created_at) as first_received,
                   MAX(created_at) as last_received
            FROM warehouse_stocks
            WHERE status = 'in_stock' AND quantity_kg > 0
            GROUP BY product_name
            ORDER BY SUM(quantity_kg) DESC
        `);
        const inventory = aggResult.rows;

        const packResult = await pool.query(`
            SELECT po.product_name, u.name as employee_name, po.boxes_packed, po.quantity_kg, po.status, po.updated_at
            FROM packing_orders po
            LEFT JOIN users u ON po.assigned_employee_id = u.id
            WHERE po.status IN ('packed', 'dispatched')
            ORDER BY po.product_name, po.updated_at DESC
        `);

        const packingByProduct = {};
        packResult.rows.forEach(p => {
            if (!packingByProduct[p.product_name]) {
                packingByProduct[p.product_name] = { employees: [], total_boxes: 0, total_kg: 0 };
            }
            packingByProduct[p.product_name].employees.push({
                name: p.employee_name || 'Unknown', boxes: p.boxes_packed || 0, kg: p.quantity_kg || 0, status: p.status
            });
            packingByProduct[p.product_name].total_boxes += (p.boxes_packed || 0);
            packingByProduct[p.product_name].total_kg += (p.quantity_kg || 0);
        });

        const pendingResult = await pool.query(`
            SELECT wd.product_name, wd.quantity_kg, wd.status, u.name as driver_name
            FROM warehouse_deliveries wd
            LEFT JOIN users u ON wd.driver_id = u.id
            WHERE wd.status != 'delivered'
            ORDER BY wd.created_at DESC
        `);

        const totalProducts = inventory.length;
        const totalKg = inventory.reduce((s, i) => s + (parseFloat(i.total_kg) || 0), 0);
        const totalBatches = inventory.reduce((s, i) => s + (parseInt(i.batch_count) || 0), 0);

        res.json({
            inventory,
            packing_by_product: packingByProduct,
            pending_handovers: pendingResult.rows,
            summary: { total_products: totalProducts, total_kg: totalKg, total_batches: totalBatches }
        });
    } catch (err) {
        console.error('Inventory error:', err);
        res.status(500).json({ error: 'Failed to fetch inventory' });
    }
});

// ===== INCOMING DELIVERIES =====
router.get('/incoming', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT wd.*, d.name as driver_name, d.phone as driver_phone
            FROM warehouse_deliveries wd
            LEFT JOIN users d ON wd.driver_id = d.id
            ORDER BY wd.created_at DESC
        `);
        res.json({ deliveries: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch deliveries' });
    }
});

// ===== CONFIRM DELIVERY =====
router.put('/incoming/:id/receive', async (req, res) => {
    try {
        const pool = getDb();
        const del = await pool.query("SELECT * FROM warehouse_deliveries WHERE id = $1", [req.params.id]);
        if (del.rows.length === 0) return res.status(404).json({ error: 'Delivery not found' });
        const d = del.rows[0];

        await pool.query("UPDATE warehouse_deliveries SET status = 'delivered', updated_at = NOW() WHERE id = $1", [d.id]);

        if (d.driver_id) await pool.query("UPDATE users SET is_free = 1 WHERE id = $1", [d.driver_id]);

        const batchNo = `BATCH-${String(d.id).padStart(3, '0')}-${Date.now().toString(36).toUpperCase().slice(-4)}`;
        await pool.query("INSERT INTO warehouse_stocks (packing_order_id, product_name, quantity_kg, category, batch_no, location, status) VALUES ($1,$2,$3,'Waste Product',$4,'Main Warehouse','in_stock')",
            [d.packing_order_id, d.product_name, d.quantity_kg, batchNo]);

        if (d.packing_order_id) await pool.query("UPDATE packing_orders SET status = 'dispatched' WHERE id = $1", [d.packing_order_id]);

        res.json({ message: `${d.product_name} received at warehouse! Stock updated.` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to receive delivery' });
    }
});

// ===== CUSTOMER ORDERS =====
router.get('/orders', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT co.*, ws.batch_no, ws.location as stock_location, d.name as driver_name
            FROM customer_orders co
            LEFT JOIN warehouse_stocks ws ON co.warehouse_stock_id = ws.id
            LEFT JOIN users d ON co.sales_driver_id = d.id
            ORDER BY co.created_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// ===== CONFIRM ORDER =====
router.put('/orders/:id/confirm', async (req, res) => {
    try {
        const pool = getDb();
        await pool.query("UPDATE customer_orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1", [req.params.id]);
        await pool.query("UPDATE sales_orders SET status = 'approved', updated_at = NOW() WHERE customer_order_id = $1", [req.params.id]);

        const io = req.app.get('io');
        if (io) {
            io.to('warehouse_manager').emit('order_confirmed', {
                orderId: req.params.id,
                message: `📦 Customer order #${req.params.id} confirmed by Sales — check stock & prepare for shipping`
            });
            io.to('auditor').emit('order_approved', {
                orderId: req.params.id,
                message: `🧾 Sales order for customer order #${req.params.id} approved — ready for invoice generation`
            });
        }

        res.json({ message: 'Order confirmed! Sent to warehouse & auditor.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to confirm order' });
    }
});

// ===== SHIP ORDER =====
router.put('/orders/:id/ship', async (req, res) => {
    try {
        const pool = getDb();
        const order = await pool.query("SELECT * FROM customer_orders WHERE id = $1", [req.params.id]);
        if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
        const o = order.rows[0];

        const zoneHub = await pool.query("SELECT zh.id FROM zone_hubs zh JOIN zones z ON zh.zone_id = z.id WHERE z.name = $1 LIMIT 1", [o.customer_zone || '']);
        const hubId = zoneHub.rows.length > 0 ? zoneHub.rows[0].id : null;

        const freeDriver = await pool.query("SELECT id, name FROM users WHERE role = 'sales_driver' AND zone = $1 AND is_free = 1 LIMIT 1", [o.customer_zone || '']);
        let driverId = null;
        let driverName = 'No driver available';
        if (freeDriver.rows.length > 0) {
            driverId = freeDriver.rows[0].id;
            driverName = freeDriver.rows[0].name;
            await pool.query("UPDATE users SET is_free = 0 WHERE id = $1", [driverId]);
        } else {
            // Fallback: find any free sales driver if no zone match
            const anyDriver = await pool.query("SELECT id, name FROM users WHERE role = 'sales_driver' AND is_free = 1 LIMIT 1");
            if (anyDriver.rows.length > 0) {
                driverId = anyDriver.rows[0].id;
                driverName = anyDriver.rows[0].name;
                await pool.query("UPDATE users SET is_free = 0 WHERE id = $1", [driverId]);
            }
        }

        await pool.query("UPDATE customer_orders SET status = 'shipped', sales_driver_id = $1, zone_hub_id = $2, updated_at = NOW() WHERE id = $3", [driverId, hubId, req.params.id]);

        if (o.warehouse_stock_id) {
            await pool.query("UPDATE warehouse_stocks SET quantity_kg = quantity_kg - $1, updated_at = NOW() WHERE id = $2", [o.quantity_kg, o.warehouse_stock_id]);
        }

        res.json({ message: `Order shipped! Driver: ${driverName}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to ship order' });
    }
});

// ===== WAREHOUSE DRIVER: Update GPS =====
router.put('/driver/gps', async (req, res) => {
    try {
        const pool = getDb();
        const { delivery_id, lat, lng, gps_active } = req.body;
        await pool.query("UPDATE warehouse_deliveries SET driver_lat = $1, driver_lng = $2, gps_active = $3, updated_at = NOW() WHERE id = $4 AND driver_id = $5",
            [lat, lng, gps_active ? 1 : 0, delivery_id, req.user.id]);
        res.json({ message: 'GPS updated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update GPS' });
    }
});

// ===== WAREHOUSE DRIVER: My deliveries =====
router.get('/driver/deliveries', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT wd.*, po.product_name as pack_product
            FROM warehouse_deliveries wd
            LEFT JOIN packing_orders po ON wd.packing_order_id = po.id
            WHERE wd.driver_id = $1
            ORDER BY wd.created_at DESC
        `, [req.user.id]);
        res.json({ deliveries: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch deliveries' });
    }
});

// ===== WAREHOUSE DRIVER: update delivery status =====
router.put('/driver/deliveries/:id/status', async (req, res) => {
    try {
        const pool = getDb();
        const { status } = req.body;
        const validStatuses = ['pending', 'picked_up', 'in_transit', 'delivered'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

        const delInfo = await pool.query("SELECT product_name, quantity_kg FROM warehouse_deliveries WHERE id = $1", [req.params.id]);
        const productName = delInfo.rows.length > 0 ? delInfo.rows[0].product_name : 'Product';
        const qty = delInfo.rows.length > 0 ? delInfo.rows[0].quantity_kg : 0;

        await pool.query("UPDATE warehouse_deliveries SET status = $1, gps_active = $2, updated_at = NOW() WHERE id = $3 AND driver_id = $4",
            [status, status === 'in_transit' ? 1 : 0, req.params.id, req.user.id]);

        if (status === 'delivered') {
            await pool.query("UPDATE users SET is_free = 1 WHERE id = $1", [req.user.id]);
        }

        const io = req.app.get('io');
        if (io) {
            const statusMessages = {
                picked_up: `🚛 Driver ${req.user.name} PICKED UP: ${productName} (${qty}kg)`,
                in_transit: `🚚 Driver ${req.user.name} IN TRANSIT: ${productName} (${qty}kg) — GPS tracking active`,
                delivered: `📦 Driver ${req.user.name} DELIVERED: ${productName} (${qty}kg) — Please confirm receipt`
            };
            io.to('warehouse_manager').emit('delivery_status_update', {
                deliveryId: parseInt(req.params.id), status, driverName: req.user.name,
                productName, quantity_kg: qty,
                message: statusMessages[status] || `Delivery #${req.params.id}: ${status}`
            });
        }

        res.json({ message: `Delivery status: ${status}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// ===== ZONES =====
router.get('/zones', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query("SELECT z.*, zh.name as hub_name, zh.address as hub_address FROM zones z LEFT JOIN zone_hubs zh ON zh.zone_id = z.id ORDER BY z.name");
        res.json({ zones: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch zones' });
    }
});

// ===== SALES ORDERS =====
router.get('/sales-orders', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT so.*, u.name as sales_person_name,
                   i.invoice_no, i.total_amount as invoice_total, i.payment_status
            FROM sales_orders so
            LEFT JOIN users u ON so.sales_person_id = u.id
            LEFT JOIN invoices i ON i.sales_order_id = so.id
            ORDER BY CASE so.status
                WHEN 'pending' THEN 1 WHEN 'paid' THEN 2 WHEN 'approved' THEN 3
                WHEN 'invoiced' THEN 4 WHEN 'dispatched' THEN 5 ELSE 6 END
        `);
        res.json({ orders: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch sales orders' }); }
});

// ===== APPROVE SALES ORDER =====
router.put('/sales-orders/:id/approve', async (req, res) => {
    try {
        const pool = getDb();
        const so = await pool.query("SELECT * FROM sales_orders WHERE id = $1", [req.params.id]);
        if (so.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
        const order = so.rows[0];

        if (order.status !== 'pending') return res.status(400).json({ error: 'Only pending orders can be approved' });

        const { warehouse_notes } = req.body;
        await pool.query("UPDATE sales_orders SET status = 'approved', warehouse_notes = $1, updated_at = NOW() WHERE id = $2",
            [warehouse_notes || 'Stock verified. Approved for invoicing.', req.params.id]);

        const io = req.app.get('io');
        if (io) {
            io.to('auditor').emit('order_approved', {
                orderId: req.params.id, product: order.product_name,
                message: `Sales order #${req.params.id} approved! Generate invoice for ${order.product_name} (${order.quantity_kg}kg)`
            });
        }
        res.json({ message: `Order #${req.params.id} approved! Sent to auditor for invoicing.` });
    } catch (err) { res.status(500).json({ error: 'Failed to approve order' }); }
});

// ===== DISPATCH PAID ORDER =====
router.put('/sales-orders/:id/dispatch', async (req, res) => {
    try {
        const pool = getDb();
        const so = await pool.query("SELECT * FROM sales_orders WHERE id = $1", [req.params.id]);
        if (so.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
        const order = so.rows[0];

        if (order.status !== 'paid') return res.status(400).json({ error: 'Only paid orders can be dispatched' });

        await pool.query("UPDATE sales_orders SET status = 'dispatched', updated_at = NOW() WHERE id = $1", [req.params.id]);

        const io = req.app.get('io');
        if (io) {
            io.to('sales_team').emit('order_dispatched', {
                orderId: req.params.id,
                message: `Order #${req.params.id} dispatched! ${order.product_name} (${order.quantity_kg}kg) to ${order.customer_name}`
            });
        }
        res.json({ message: `Order #${req.params.id} dispatched with invoice!` });
    } catch (err) { res.status(500).json({ error: 'Failed to dispatch order' }); }
});

module.exports = router;
