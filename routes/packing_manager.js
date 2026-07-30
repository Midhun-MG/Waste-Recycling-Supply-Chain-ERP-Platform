const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('packing_manager'));

// ===== DASHBOARD STATS =====
router.get('/stats', async (req, res) => {
    try {
        const pool = getDb();
        const totalOrders = await pool.query("SELECT COUNT(*) as c FROM packing_orders");
        const pending = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE status = 'pending'");
        const packing = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE status = 'packing'");
        const packed = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE status IN ('packed','dispatched')");
        const unassigned = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE assigned_employee_id IS NULL AND status = 'pending'");
        const totalBoxes = await pool.query("SELECT COALESCE(SUM(boxes_packed),0) as c FROM packing_orders WHERE status IN ('packed','dispatched')");

        res.json({
            stats: {
                total_orders: parseInt(totalOrders.rows[0].c) || 0,
                pending: parseInt(pending.rows[0].c) || 0,
                packing: parseInt(packing.rows[0].c) || 0,
                packed: parseInt(packed.rows[0].c) || 0,
                unassigned: parseInt(unassigned.rows[0].c) || 0,
                total_boxes: parseInt(totalBoxes.rows[0].c) || 0
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ===== ALL EMPLOYEES STATUS =====
router.get('/employees', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT u.id, u.name, u.email, u.is_free,
                   COUNT(po.id) as total_tasks,
                   SUM(CASE WHEN po.status = 'packing' THEN 1 ELSE 0 END) as active_tasks,
                   SUM(CASE WHEN po.status IN ('packed','dispatched') THEN 1 ELSE 0 END) as completed_tasks,
                   SUM(CASE WHEN po.status = 'pending' THEN 1 ELSE 0 END) as pending_tasks,
                   COALESCE(SUM(po.boxes_packed), 0) as total_boxes_packed,
                   COALESCE(SUM(CASE WHEN po.status IN ('packed','dispatched') THEN po.quantity_kg ELSE 0 END), 0) as total_kg_packed
            FROM users u
            LEFT JOIN packing_orders po ON po.assigned_employee_id = u.id
            WHERE u.role = 'packing_employee'
            GROUP BY u.id, u.name, u.email, u.is_free
            ORDER BY u.name
        `);
        res.json({ employees: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch employees' });
    }
});

// ===== ALL PACKING ORDERS =====
router.get('/orders', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, u.name as employee_name, prod.item_name as source_raw_item
            FROM packing_orders po
            LEFT JOIN users u ON po.assigned_employee_id = u.id
            LEFT JOIN production_orders prod ON po.production_order_id = prod.id
            ORDER BY 
                CASE po.status 
                    WHEN 'packing' THEN 1 
                    WHEN 'pending' THEN 2 
                    WHEN 'packed' THEN 3 
                    WHEN 'dispatched' THEN 4 
                END,
                po.updated_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// ===== PRODUCT SUMMARY =====
router.get('/products', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.product_name,
                   COUNT(*) as order_count,
                   SUM(CASE WHEN po.status = 'pending' THEN 1 ELSE 0 END) as pending,
                   SUM(CASE WHEN po.status = 'packing' THEN 1 ELSE 0 END) as packing,
                   SUM(CASE WHEN po.status IN ('packed','dispatched') THEN 1 ELSE 0 END) as completed,
                   COALESCE(SUM(po.boxes_packed), 0) as total_boxes,
                   COALESCE(SUM(po.quantity_kg), 0) as total_kg,
                   STRING_AGG(DISTINCT u.name, ',') as employees
            FROM packing_orders po
            LEFT JOIN users u ON po.assigned_employee_id = u.id
            GROUP BY po.product_name
            ORDER BY po.product_name
        `);
        res.json({ products: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

module.exports = router;
