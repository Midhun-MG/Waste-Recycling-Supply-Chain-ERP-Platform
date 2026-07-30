const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('packing_employee'));

// Get my assigned packing tasks
router.get('/tasks', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, prod.item_name as source_raw_item, prod.predicted_product, prod.estimated_hours
            FROM packing_orders po
            LEFT JOIN production_orders prod ON po.production_order_id = prod.id
            WHERE po.assigned_employee_id = $1
            ORDER BY po.status ASC, po.created_at DESC
        `, [req.user.id]);
        res.json({ tasks: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// Get available (unassigned) packing tasks
router.get('/available', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, prod.item_name as source_raw_item, prod.predicted_product
            FROM packing_orders po
            LEFT JOIN production_orders prod ON po.production_order_id = prod.id
            WHERE po.assigned_employee_id IS NULL AND po.status = 'pending'
            ORDER BY po.created_at ASC
        `);
        res.json({ tasks: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch available tasks' });
    }
});

// Accept a packing task
router.put('/tasks/:id/accept', async (req, res) => {
    try {
        const pool = getDb();
        const check = await pool.query("SELECT * FROM packing_orders WHERE id = $1 AND assigned_employee_id IS NULL AND status = 'pending'", [req.params.id]);
        if (check.rows.length === 0) {
            return res.status(400).json({ error: 'Task already taken or not available' });
        }
        await pool.query("UPDATE packing_orders SET assigned_employee_id = $1, status = 'pending', updated_at = NOW() WHERE id = $2",
            [req.user.id, req.params.id]);
        await pool.query("UPDATE users SET is_free = 0 WHERE id = $1", [req.user.id]);

        const io = req.app.get('io');
        if (io) io.to('packing_manager').emit('task_accepted', { employee: req.user.name, taskId: req.params.id });

        res.json({ message: 'Task accepted! Click Start Packing when ready.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to accept task' });
    }
});

// Get all packing orders
router.get('/all-orders', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, prod.item_name as source_raw_item, u.name as assigned_to
            FROM packing_orders po
            LEFT JOIN production_orders prod ON po.production_order_id = prod.id
            LEFT JOIN users u ON po.assigned_employee_id = u.id
            ORDER BY po.created_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// Start packing
router.put('/tasks/:id/start', async (req, res) => {
    try {
        const pool = getDb();
        await pool.query("UPDATE packing_orders SET status = 'packing', updated_at = NOW() WHERE id = $1 AND assigned_employee_id = $2", [req.params.id, req.user.id]);
        await pool.query("UPDATE users SET is_free = 0 WHERE id = $1", [req.user.id]);
        res.json({ message: 'Packing started! Pack 100 items per box.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to start packing' });
    }
});

// Complete one box
router.put('/tasks/:id/complete-box', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query("SELECT * FROM packing_orders WHERE id = $1 AND assigned_employee_id = $2", [req.params.id, req.user.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        const order = result.rows[0];

        const newBoxes = (order.boxes_packed || 0) + 1;
        const itemsPacked = newBoxes * (order.items_per_box || 100);
        const totalNeeded = order.total_items || 100;
        const allDone = itemsPacked >= totalNeeded;

        if (allDone) {
            await pool.query("UPDATE packing_orders SET boxes_packed = $1, total_items = $2, status = 'packed', updated_at = NOW() WHERE id = $3",
                [newBoxes, itemsPacked, req.params.id]);

            const freeDriver = await pool.query("SELECT id, name FROM users WHERE role = 'warehouse_driver' AND is_free = 1 LIMIT 1");
            let driverId = null;
            if (freeDriver.rows.length > 0) {
                driverId = freeDriver.rows[0].id;
                await pool.query("UPDATE users SET is_free = 0 WHERE id = $1", [driverId]);
            }
            await pool.query("INSERT INTO warehouse_deliveries (packing_order_id, driver_id, product_name, quantity_kg, status) VALUES ($1,$2,$3,$4,'pending')",
                [order.id, driverId, order.product_name, order.quantity_kg]);

            const nextTask = await pool.query("SELECT id, product_name FROM packing_orders WHERE assigned_employee_id IS NULL AND status = 'pending' ORDER BY created_at ASC LIMIT 1");
            if (nextTask.rows.length > 0) {
                const nextId = nextTask.rows[0].id;
                const nextProduct = nextTask.rows[0].product_name;
                await pool.query("UPDATE packing_orders SET assigned_employee_id = $1 WHERE id = $2", [req.user.id, nextId]);
                res.json({
                    message: `All ${newBoxes} boxes packed! Sent to warehouse. AI assigned next task: ${nextProduct}`,
                    all_done: true, boxes_packed: newBoxes, next_task: nextProduct
                });
            } else {
                await pool.query("UPDATE users SET is_free = 1 WHERE id = $1", [req.user.id]);
                res.json({
                    message: `All ${newBoxes} boxes packed! Sent to warehouse. No more tasks.`,
                    all_done: true, boxes_packed: newBoxes, next_task: null
                });
            }
        } else {
            await pool.query("UPDATE packing_orders SET boxes_packed = $1, updated_at = NOW() WHERE id = $2", [newBoxes, req.params.id]);
            const remaining = Math.ceil((totalNeeded - itemsPacked) / (order.items_per_box || 100));
            res.json({
                message: `Box #${newBoxes} packed (${order.items_per_box || 100} items)! ${remaining} boxes remaining.`,
                all_done: false, boxes_packed: newBoxes, boxes_remaining: remaining, items_packed: itemsPacked, total_items: totalNeeded
            });
        }
    } catch (err) {
        console.error('Complete box error:', err);
        res.status(500).json({ error: 'Failed to complete box' });
    }
});

// Complete packing (legacy)
router.put('/tasks/:id/complete', async (req, res) => {
    try {
        const pool = getDb();
        await pool.query("UPDATE packing_orders SET status = 'packed', updated_at = NOW() WHERE id = $1 AND assigned_employee_id = $2", [req.params.id, req.user.id]);

        const order = await pool.query("SELECT * FROM packing_orders WHERE id = $1", [req.params.id]);
        if (order.rows.length > 0) {
            const o = order.rows[0];
            const freeDriver = await pool.query("SELECT id, name FROM users WHERE role = 'warehouse_driver' AND is_free = 1 LIMIT 1");
            let driverId = null;
            if (freeDriver.rows.length > 0) {
                driverId = freeDriver.rows[0].id;
                await pool.query("UPDATE users SET is_free = 0 WHERE id = $1", [driverId]);
            }
            await pool.query("INSERT INTO warehouse_deliveries (packing_order_id, driver_id, product_name, quantity_kg, status) VALUES ($1,$2,$3,$4,'pending')",
                [o.id, driverId, o.product_name, o.quantity_kg]);
        }

        const nextTask = await pool.query("SELECT id, product_name FROM packing_orders WHERE assigned_employee_id IS NULL AND status = 'pending' ORDER BY created_at ASC LIMIT 1");
        if (nextTask.rows.length > 0) {
            await pool.query("UPDATE packing_orders SET assigned_employee_id = $1 WHERE id = $2", [req.user.id, nextTask.rows[0].id]);
        } else {
            await pool.query("UPDATE users SET is_free = 1 WHERE id = $1", [req.user.id]);
        }

        res.json({ message: 'Packing completed! Sent to warehouse.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to complete packing' });
    }
});

// My profile / stats
router.get('/profile', async (req, res) => {
    try {
        const pool = getDb();
        const activeCount = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE assigned_employee_id = $1 AND status = 'packing'", [req.user.id]);
        const completedCount = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE assigned_employee_id = $1 AND status IN ('packed','dispatched')", [req.user.id]);
        const pendingCount = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE assigned_employee_id = $1 AND status = 'pending'", [req.user.id]);
        const totalBoxes = await pool.query("SELECT COALESCE(SUM(boxes_packed),0) as c FROM packing_orders WHERE assigned_employee_id = $1", [req.user.id]);

        res.json({
            user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
            stats: {
                active: parseInt(activeCount.rows[0].c) || 0,
                completed: parseInt(completedCount.rows[0].c) || 0,
                pending: parseInt(pendingCount.rows[0].c) || 0,
                total_boxes: parseInt(totalBoxes.rows[0].c) || 0
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

module.exports = router;
