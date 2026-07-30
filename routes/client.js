const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole('client'));

// Create pickup request
router.post('/pickup', async (req, res) => {
    try {
        const pool = getDb();
        const { waste_type, quantity_kg, description } = req.body;

        if (!waste_type || !quantity_kg) {
            return res.status(400).json({ error: 'Waste type and quantity are required' });
        }

        // Get client details
        const userResult = await pool.query("SELECT shop_name, address, pincode, lat, lng FROM users WHERE id = $1", [req.user.id]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        const result = await pool.query(
            `INSERT INTO pickup_requests (client_id, waste_type, quantity_kg, description, shop_name, shop_address, shop_pincode, pickup_lat, pickup_lng) 
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [req.user.id, waste_type, quantity_kg, description || '', user.shop_name, user.address, user.pincode, user.lat, user.lng]
        );

        const requestId = result.rows[0].id;

        // Notify via socket
        const io = req.app.get('io');
        if (io) {
            io.emit('new_pickup_request', {
                requestId,
                shopName: user.shop_name,
                wasteType: waste_type,
                quantity: quantity_kg
            });
        }

        res.json({
            message: 'Pickup request created successfully',
            request_id: requestId
        });
    } catch (err) {
        console.error('Create pickup error:', err);
        res.status(500).json({ error: 'Failed to create pickup request' });
    }
});

// Cancel pickup request
router.put('/pickup/:id/cancel', async (req, res) => {
    try {
        const pool = getDb();

        const check = await pool.query(
            "SELECT id, status FROM pickup_requests WHERE id = $1 AND client_id = $2",
            [req.params.id, req.user.id]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Request not found' });
        }

        if (check.rows[0].status !== 'pending') {
            return res.status(400).json({ error: 'Can only cancel pending requests' });
        }

        await pool.query(
            "UPDATE pickup_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
            [req.params.id]
        );

        res.json({ message: 'Pickup request cancelled' });
    } catch (err) {
        console.error('Cancel pickup error:', err);
        res.status(500).json({ error: 'Failed to cancel request' });
    }
});

// Get my pickup requests
router.get('/pickups', async (req, res) => {
    try {
        const pool = getDb();

        const result = await pool.query(`
            SELECT pr.*, u.name as driver_name, u.phone as driver_phone
            FROM pickup_requests pr
            LEFT JOIN users u ON pr.driver_id = u.id
            WHERE pr.client_id = $1
            ORDER BY pr.created_at DESC
        `, [req.user.id]);

        res.json({ requests: result.rows });
    } catch (err) {
        console.error('List requests error:', err);
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

// Get notifications
router.get('/notifications', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(
            "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
            [req.user.id]
        );
        res.json({ notifications: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// Mark notifications read
router.put('/notifications/read', async (req, res) => {
    try {
        const pool = getDb();
        await pool.query("UPDATE notifications SET is_read = 1 WHERE user_id = $1", [req.user.id]);
        res.json({ message: 'Notifications marked as read' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update notifications' });
    }
});

// Get profile
router.get('/profile', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(
            "SELECT id, name, email, phone, shop_name, address, pincode, role FROM users WHERE id = $1",
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const stats = await pool.query(
            "SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) as completed, COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) as pending FROM pickup_requests WHERE client_id = $1",
            [req.user.id]
        );

        res.json({
            user: result.rows[0],
            stats: stats.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// Update profile
router.put('/profile', async (req, res) => {
    try {
        const pool = getDb();
        const { name, phone, shop_name, address, pincode } = req.body;

        await pool.query(
            "UPDATE users SET name = $1, phone = $2, shop_name = $3, address = $4, pincode = $5 WHERE id = $6",
            [name, phone, shop_name, address, pincode, req.user.id]
        );

        res.json({ message: 'Profile updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

module.exports = router;
