const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Allow both production_employee AND production_manager
router.use((req, res, next) => {
    if (req.user.role !== 'production_employee' && req.user.role !== 'production_manager') {
        return res.status(403).json({ error: 'Access denied. Production role required.' });
    }
    next();
});

// ===== MANAGER: Dashboard Stats =====
router.get('/manager/stats', async (req, res) => {
    try {
        const pool = getDb();
        const prodEmployees = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'production_employee'");
        const packEmployees = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'packing_employee'");
        const freePackers = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'packing_employee' AND is_free = 1");
        const busyPackers = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'packing_employee' AND is_free = 0");
        const freeProdEmp = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'production_employee' AND is_free = 1");
        const busyProdEmp = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'production_employee' AND is_free = 0");
        const pendingProd = await pool.query("SELECT COUNT(*) as c FROM production_orders WHERE status = 'pending'");
        const activeProd = await pool.query("SELECT COUNT(*) as c FROM production_orders WHERE status = 'in_production'");
        const completedProd = await pool.query("SELECT COUNT(*) as c FROM production_orders WHERE status = 'completed'");
        const pendingPack = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE status = 'pending'");
        const activePack = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE status = 'packing'");
        const completedPack = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE status IN ('packed','dispatched')");
        const totalBoxes = await pool.query("SELECT COALESCE(SUM(boxes_packed),0) as c FROM packing_orders");
        const totalItems = await pool.query("SELECT COALESCE(SUM(total_items),0) as c FROM packing_orders");

        res.json({
            production_employees: { total: parseInt(prodEmployees.rows[0].c), free: parseInt(freeProdEmp.rows[0].c), busy: parseInt(busyProdEmp.rows[0].c) },
            packing_employees: { total: parseInt(packEmployees.rows[0].c), free: parseInt(freePackers.rows[0].c), busy: parseInt(busyPackers.rows[0].c) },
            production: { pending: parseInt(pendingProd.rows[0].c), active: parseInt(activeProd.rows[0].c), completed: parseInt(completedProd.rows[0].c) },
            packing: { pending: parseInt(pendingPack.rows[0].c), active: parseInt(activePack.rows[0].c), completed: parseInt(completedPack.rows[0].c) },
            totals: { boxes_packed: parseInt(totalBoxes.rows[0].c), items_packed: parseInt(totalItems.rows[0].c) }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch manager stats' });
    }
});

// ===== MANAGER: All Production Employees =====
router.get('/manager/production-employees', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT u.id, u.name, u.email, u.phone, u.is_free,
                (SELECT COUNT(*) FROM production_orders WHERE assigned_employee_id = u.id AND status = 'in_production') as active_tasks,
                (SELECT COUNT(*) FROM production_orders WHERE assigned_employee_id = u.id AND status = 'completed') as completed_tasks,
                (SELECT predicted_product FROM production_orders WHERE assigned_employee_id = u.id AND status = 'in_production' ORDER BY created_at DESC LIMIT 1) as current_product
            FROM users u WHERE u.role = 'production_employee' ORDER BY u.name
        `);
        res.json({ employees: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch production employees' });
    }
});

// ===== MANAGER: All Packing Employees =====
router.get('/manager/packing-employees', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT u.id, u.name, u.email, u.phone, u.is_free,
                (SELECT COUNT(*) FROM packing_orders WHERE assigned_employee_id = u.id AND status = 'packing') as active_tasks,
                (SELECT COUNT(*) FROM packing_orders WHERE assigned_employee_id = u.id AND status IN ('packed','dispatched')) as completed_tasks,
                (SELECT COALESCE(SUM(boxes_packed),0) FROM packing_orders WHERE assigned_employee_id = u.id) as total_boxes,
                (SELECT product_name FROM packing_orders WHERE assigned_employee_id = u.id AND status = 'packing' ORDER BY created_at DESC LIMIT 1) as current_product
            FROM users u WHERE u.role = 'packing_employee' ORDER BY u.name
        `);
        res.json({ employees: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch packing employees' });
    }
});

// ===== MANAGER: All Production Orders =====
router.get('/manager/orders', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, u.name as assigned_to, c.name as created_by_name
            FROM production_orders po
            LEFT JOIN users u ON po.assigned_employee_id = u.id
            LEFT JOIN users c ON po.created_by = c.id
            ORDER BY po.created_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// ===== MANAGER: All Packing Orders =====
router.get('/manager/packing-orders', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, u.name as assigned_to, prod.predicted_product
            FROM packing_orders po
            LEFT JOIN users u ON po.assigned_employee_id = u.id
            LEFT JOIN production_orders prod ON po.production_order_id = prod.id
            ORDER BY po.created_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch packing orders' });
    }
});

// ===== EMPLOYEE: Get my assigned production tasks =====
router.get('/tasks', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, u.name as created_by_name
            FROM production_orders po
            LEFT JOIN users u ON po.created_by = u.id
            WHERE po.assigned_employee_id = $1
            ORDER BY po.created_at DESC
        `, [req.user.id]);
        res.json({ tasks: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// Get all production orders
router.get('/all-orders', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, u.name as assigned_to, c.name as created_by_name
            FROM production_orders po
            LEFT JOIN users u ON po.assigned_employee_id = u.id
            LEFT JOIN users c ON po.created_by = c.id
            ORDER BY po.created_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// Start production
router.put('/tasks/:id/start', async (req, res) => {
    try {
        const pool = getDb();
        const task = await pool.query("SELECT * FROM production_orders WHERE id = $1 AND assigned_employee_id = $2", [req.params.id, req.user.id]);
        if (task.rows.length === 0) {
            return res.status(404).json({ error: 'Task not found or not assigned to you' });
        }
        await pool.query("UPDATE production_orders SET status = 'in_production', started_at = NOW(), updated_at = NOW() WHERE id = $1", [req.params.id]);
        await pool.query("UPDATE users SET is_free = 0 WHERE id = $1", [req.user.id]);
        res.json({ message: 'Production started! Timer running.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to start production' });
    }
});

// Complete production
router.put('/tasks/:id/complete', async (req, res) => {
    try {
        const pool = getDb();
        await pool.query("UPDATE production_orders SET status = 'completed', updated_at = NOW() WHERE id = $1 AND assigned_employee_id = $2", [req.params.id, req.user.id]);
        await pool.query("UPDATE users SET is_free = 1 WHERE id = $1", [req.user.id]);
        res.json({ message: 'Production completed!' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to complete task' });
    }
});

// My profile / stats
router.get('/profile', async (req, res) => {
    try {
        const pool = getDb();
        const activeCount = await pool.query("SELECT COUNT(*) as c FROM production_orders WHERE assigned_employee_id = $1 AND status = 'in_production'", [req.user.id]);
        const completedCount = await pool.query("SELECT COUNT(*) as c FROM production_orders WHERE assigned_employee_id = $1 AND status = 'completed'", [req.user.id]);
        const pendingCount = await pool.query("SELECT COUNT(*) as c FROM production_orders WHERE assigned_employee_id = $1 AND status = 'pending'", [req.user.id]);

        res.json({
            user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
            stats: {
                active: parseInt(activeCount.rows[0].c) || 0,
                completed: parseInt(completedCount.rows[0].c) || 0,
                pending: parseInt(pendingCount.rows[0].c) || 0
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// ===== EMPLOYEE: Incoming Deliveries =====
router.get('/deliveries', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT inv.*, d.name as driver_name, d.phone as driver_phone
            FROM inventory inv
            LEFT JOIN users d ON inv.source_driver_id = d.id
            WHERE inv.status = 'received'
            ORDER BY inv.received_at DESC
        `);
        res.json({ deliveries: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch deliveries' });
    }
});

// ===== EMPLOYEE: Confirm delivery =====
router.put('/deliveries/:id/confirm', async (req, res) => {
    try {
        const pool = getDb();
        const check = await pool.query("SELECT * FROM inventory WHERE id = $1 AND status = 'received'", [req.params.id]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Delivery not found or already confirmed' });
        }

        const item = check.rows[0];

        await pool.query("UPDATE inventory SET status = 'processing', updated_at = NOW() WHERE id = $1", [req.params.id]);

        const driverId = item.source_driver_id;
        if (driverId) {
            const remaining = await pool.query(
                "SELECT COUNT(*) as c FROM inventory WHERE source_driver_id = $1 AND status IN ('in_transit', 'received')",
                [driverId]
            );
            const remainingCount = parseInt(remaining.rows[0].c) || 0;
            if (remainingCount === 0) {
                await pool.query("UPDATE users SET is_free = 1 WHERE id = $1", [driverId]);
                await pool.query(
                    `INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)`,
                    [driverId, `✅ All goods confirmed by production. You are now FREE for new pickups!`, 'driver_freed']
                );
            }
        }

        const io = req.app.get('io');
        if (io) {
            io.emit('delivery_confirmed', { itemId: req.params.id, itemName: item.item_name, confirmedBy: req.user.name, driverId: driverId });
        }

        res.json({ message: `"${item.item_name}" confirmed and stored to inventory!` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to confirm delivery' });
    }
});

// ===== EMPLOYEE: View current inventory =====
router.get('/inventory', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT inv.*, d.name as driver_name
            FROM inventory inv
            LEFT JOIN users d ON inv.source_driver_id = d.id
            WHERE inv.status IN ('received', 'processing')
            ORDER BY inv.received_at DESC
        `);
        res.json({ inventory: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch inventory' });
    }
});

module.exports = router;
