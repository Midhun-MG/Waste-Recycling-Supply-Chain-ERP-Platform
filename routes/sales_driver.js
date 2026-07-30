const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('sales_driver'));

// My delivery tasks
router.get('/tasks', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT co.*, zh.name as hub_name, zh.address as hub_address, z.name as zone_name
            FROM customer_orders co
            LEFT JOIN zone_hubs zh ON co.zone_hub_id = zh.id
            LEFT JOIN zones z ON zh.zone_id = z.id
            WHERE co.sales_driver_id = $1
            ORDER BY co.created_at DESC
        `, [req.user.id]);
        res.json({ tasks: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// Update delivery status
router.put('/tasks/:id/status', async (req, res) => {
    try {
        const pool = getDb();
        const { status } = req.body;
        const validStatuses = ['shipped', 'at_zone_hub', 'out_for_delivery', 'delivered'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

        await pool.query("UPDATE customer_orders SET status = $1, updated_at = NOW() WHERE id = $2 AND sales_driver_id = $3",
            [status, req.params.id, req.user.id]);

        if (status === 'delivered') {
            await pool.query("UPDATE users SET is_free = 1 WHERE id = $1", [req.user.id]);
        }

        res.json({ message: `Order status: ${status.replace(/_/g, ' ')}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// My profile / stats
router.get('/profile', async (req, res) => {
    try {
        const pool = getDb();
        const user = await pool.query("SELECT name, email, phone, zone, vehicle_type, is_free FROM users WHERE id = $1", [req.user.id]);
        const activeCount = await pool.query("SELECT COUNT(*) as c FROM customer_orders WHERE sales_driver_id = $1 AND status NOT IN ('delivered','cancelled')", [req.user.id]);
        const deliveredCount = await pool.query("SELECT COUNT(*) as c FROM customer_orders WHERE sales_driver_id = $1 AND status = 'delivered'", [req.user.id]);

        res.json({
            user: user.rows[0] || {},
            stats: {
                active: parseInt(activeCount.rows[0].c) || 0,
                delivered: parseInt(deliveredCount.rows[0].c) || 0
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

module.exports = router;
