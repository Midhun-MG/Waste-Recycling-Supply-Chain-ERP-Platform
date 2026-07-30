const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { sendInvoiceEmail } = require('../utils/email_invoice');

const router = express.Router();

// PUBLIC: Browse products (no auth needed)
router.get('/products', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query("SELECT * FROM warehouse_stocks WHERE status = 'in_stock' AND quantity_kg > 0 ORDER BY product_name");
        const products = result.rows.map(obj => {
            if (!obj.price_per_kg || obj.price_per_kg <= 0) {
                const n = (obj.product_name || '').toLowerCase();
                if (n.includes('compost') || n.includes('fertilizer')) obj.price_per_kg = 120;
                else if (n.includes('dye') || n.includes('color')) obj.price_per_kg = 250;
                else if (n.includes('oil') || n.includes('essence')) obj.price_per_kg = 350;
                else if (n.includes('fiber') || n.includes('rope') || n.includes('coir')) obj.price_per_kg = 180;
                else if (n.includes('fuel') || n.includes('gas')) obj.price_per_kg = 85;
                else if (n.includes('soap') || n.includes('clean')) obj.price_per_kg = 200;
                else if (n.includes('pack') || n.includes('toner') || n.includes('skin')) obj.price_per_kg = 300;
                else if (n.includes('pest') || n.includes('spray') || n.includes('repel')) obj.price_per_kg = 280;
                else if (n.includes('vinegar')) obj.price_per_kg = 150;
                else if (n.includes('jam') || n.includes('pickle')) obj.price_per_kg = 220;
                else if (n.includes('powder') || n.includes('spice')) obj.price_per_kg = 400;
                else obj.price_per_kg = 190;
            }
            return obj;
        });
        res.json({ products });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// PUBLIC: Get zones
router.get('/zones', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query("SELECT * FROM zones ORDER BY name");
        res.json({ zones: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch zones' });
    }
});

// ===== PLACE ORDER WITH PAYMENT =====
router.post('/order', async (req, res) => {
    try {
        const pool = getDb();
        const { customer_name, customer_phone, customer_address, customer_zone, customer_email, product_id, quantity_kg, payment_method } = req.body;

        if (!customer_name || !customer_phone || !customer_address || !product_id || !quantity_kg) {
            return res.status(400).json({ error: 'Name, phone, address, product, and quantity required' });
        }
        if (!payment_method || !['upi', 'bank_transfer'].includes(payment_method)) {
            return res.status(400).json({ error: 'Payment method required (upi or bank_transfer)' });
        }

        const stock = await pool.query("SELECT * FROM warehouse_stocks WHERE id = $1 AND status = 'in_stock'", [product_id]);
        if (stock.rows.length === 0) {
            return res.status(400).json({ error: 'Product not available' });
        }
        const s = stock.rows[0];

        if (s.quantity_kg < quantity_kg) {
            return res.status(400).json({ error: `Only ${s.quantity_kg} kg available` });
        }

        const unitPrice = s.price_per_kg || 150;
        const subtotal = quantity_kg * unitPrice;
        const gstPercent = 18;
        const gstAmount = Math.round(subtotal * gstPercent / 100);
        const totalPrice = subtotal + gstAmount;
        const paymentStatus = 'paid';

        let customerId = null;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'greencycle_secret_key_2024');
                customerId = decoded.id;
            } catch (e) { /* guest checkout */ }
        }

        const orderResult = await pool.query(
            "INSERT INTO customer_orders (customer_id, customer_name, customer_phone, customer_address, customer_zone, customer_email, product_name, quantity_kg, total_price, warehouse_stock_id, status, payment_method, payment_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'placed',$11,$12) RETURNING id",
            [customerId, customer_name, customer_phone, customer_address, customer_zone || '', customer_email || '', s.product_name, quantity_kg, totalPrice, product_id, payment_method, paymentStatus]
        );
        const orderId = orderResult.rows[0].id;

        const demandData = await pool.query("SELECT COUNT(*) as cnt, SUM(quantity_kg) as total_kg FROM customer_orders WHERE product_name = $1", [s.product_name]);
        const orderCount = parseInt(demandData.rows[0].cnt) || 1;
        const totalKg = parseFloat(demandData.rows[0].total_kg) || quantity_kg;
        const demandScore = Math.min(100, Math.round((orderCount * 15) + (totalKg * 0.5)));

        const salesPerson = await pool.query("SELECT id FROM users WHERE role='sales_team' LIMIT 1");
        const salesPersonId = salesPerson.rows.length > 0 ? salesPerson.rows[0].id : null;

        const soResult = await pool.query(
            `INSERT INTO sales_orders (customer_order_id, customer_id, customer_name, customer_phone, customer_address, product_name, quantity_kg, unit_price, total_price, demand_score, demand_notes, sales_person_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') RETURNING id`,
            [orderId, customerId, customer_name, customer_phone, customer_address,
                s.product_name, quantity_kg, unitPrice, totalPrice, demandScore,
                `Auto-order: ${customer_name} paid via ${payment_method.toUpperCase()}. Demand score: ${demandScore}`,
                salesPersonId]
        );
        const salesOrderId = soResult.rows[0].id;

        const io = req.app.get('io');
        if (io) {
            io.to('sales_team').emit('new_customer_order', {
                orderId, salesOrderId, customer_name, product: s.product_name,
                quantity_kg, total_price: totalPrice, payment_method,
                message: `🆕 Order #${orderId}: ${s.product_name} (${quantity_kg}kg) — ₹${totalPrice} via ${payment_method.toUpperCase()} from ${customer_name}`
            });
            io.to('warehouse_manager').emit('new_sales_order', {
                orderId: salesOrderId, product: s.product_name, quantity: quantity_kg,
                message: `📦 New sales order #${salesOrderId}: ${s.product_name} (${quantity_kg}kg) for ${customer_name} — Check stock & approve`
            });
        }

        if (customer_email) {
            console.log(`[ORDER] Customer email saved: ${customer_email} — Invoice will be emailed by Auditor`);
        }

        res.json({
            message: `Order placed! Order #${orderId}`,
            order_id: orderId,
            sales_order_id: salesOrderId,
            subtotal, gst_amount: gstAmount, total_price: totalPrice,
            payment_method, payment_status: paymentStatus,
            email_sent: !!customer_email,
            invoice_preview: {
                product: s.product_name, quantity_kg, unit_price: unitPrice,
                subtotal, gst_percent: gstPercent, gst_amount: gstAmount, total: totalPrice
            }
        });
    } catch (err) {
        console.error('Order error:', err);
        res.status(500).json({ error: 'Failed to place order' });
    }
});

// Track order
router.get('/order/:id', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT co.*, d.name as driver_name, d.phone as driver_phone, d.vehicle_type as driver_vehicle,
                   z.name as zone_name, zh.name as hub_name
            FROM customer_orders co
            LEFT JOIN users d ON co.sales_driver_id = d.id
            LEFT JOIN zone_hubs zh ON co.zone_hub_id = zh.id
            LEFT JOIN zones z ON zh.zone_id = z.id
            WHERE co.id = $1
        `, [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        res.json({ order: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch order' });
    }
});

// My orders (authenticated customer)
router.get('/my-orders', authMiddleware, async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT co.*, d.name as driver_name,
                   so.status as sales_status, i.invoice_no, i.total_amount as invoice_total
            FROM customer_orders co
            LEFT JOIN users d ON co.sales_driver_id = d.id
            LEFT JOIN sales_orders so ON so.customer_order_id = co.id
            LEFT JOIN invoices i ON i.sales_order_id = so.id
            WHERE co.customer_id = $1
            ORDER BY co.created_at DESC
        `, [req.user.id]);
        res.json({ orders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// ===== SUBMIT FEEDBACK =====
router.post('/feedback', async (req, res) => {
    try {
        const pool = getDb();
        const { subject, message, rating } = req.body;
        if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });

        const userName = req.user.name || 'Customer';
        const userEmail = req.user.email || '';

        await pool.query(
            "INSERT INTO customer_feedback (customer_id, customer_name, customer_email, subject, message, rating) VALUES ($1,$2,$3,$4,$5,$6)",
            [req.user.id, userName, userEmail, subject, message, rating || 5]
        );

        const io = req.app.get('io');
        if (io) {
            io.to('admin').emit('new_feedback', {
                customer_name: userName, subject,
                message: `📝 New feedback from ${userName}: "${subject}"`
            });
        }

        res.json({ message: 'Feedback submitted! Admin will review it.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
});

// ===== VIEW MY FEEDBACK =====
router.get('/feedback', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query("SELECT * FROM customer_feedback WHERE customer_id = $1 ORDER BY created_at DESC", [req.user.id]);
        res.json({ feedback: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch feedback' });
    }
});

module.exports = router;
