const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole('driver'));

// Get available pickup requests (pending ones)
router.get('/requests', async (req, res) => {
    try {
        const pool = getDb();
        const { status } = req.query;

        let query, params;

        if (status === 'my') {
            query = `
                SELECT pr.*, u.name as client_name, u.phone as client_phone, u.email as client_email,
                       pr.shop_name as client_shop_name, pr.shop_address as client_address, pr.shop_pincode as client_pincode,
                       pr.pickup_lat as client_lat, pr.pickup_lng as client_lng
                FROM pickup_requests pr
                JOIN users u ON pr.client_id = u.id
                WHERE pr.driver_id = $1 AND pr.status IN ('assigned', 'in_transit', 'completed')
                ORDER BY pr.updated_at DESC
            `;
            params = [req.user.id];
        } else if (status === 'history') {
            query = `
                SELECT pr.*, u.name as client_name, u.phone as client_phone, u.email as client_email,
                       pr.shop_name as client_shop_name, pr.shop_address as client_address, pr.shop_pincode as client_pincode,
                       pr.pickup_lat as client_lat, pr.pickup_lng as client_lng
                FROM pickup_requests pr
                JOIN users u ON pr.client_id = u.id
                WHERE pr.driver_id = $1 AND pr.status IN ('delivered', 'cancelled')
                ORDER BY pr.updated_at DESC
            `;
            params = [req.user.id];
        } else {
            query = `
                SELECT pr.*, u.name as client_name, u.phone as client_phone,
                       pr.shop_name as client_shop_name, pr.shop_address as client_address, pr.shop_pincode as client_pincode,
                       pr.pickup_lat as client_lat, pr.pickup_lng as client_lng
                FROM pickup_requests pr
                JOIN users u ON pr.client_id = u.id
                WHERE pr.status = 'pending'
                ORDER BY pr.created_at DESC
            `;
            params = [];
        }

        const result = await pool.query(query, params);
        res.json({ requests: result.rows });
    } catch (err) {
        console.error('Driver requests error:', err);
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

// Accept a pickup request
router.put('/requests/:id/accept', async (req, res) => {
    try {
        const pool = getDb();
        const requestId = req.params.id;

        const check = await pool.query(
            "SELECT id, status, client_id FROM pickup_requests WHERE id = $1",
            [requestId]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Request not found' });
        }

        if (check.rows[0].status !== 'pending') {
            return res.status(400).json({ error: 'Request is no longer available' });
        }

        const clientId = check.rows[0].client_id;

        await pool.query(
            "UPDATE pickup_requests SET driver_id = $1, status = 'assigned', updated_at = NOW() WHERE id = $2",
            [req.user.id, requestId]
        );

        // Mark driver as BUSY
        await pool.query("UPDATE users SET is_free = 0 WHERE id = $1", [req.user.id]);

        // Notify the client
        await pool.query(
            `INSERT INTO notifications (user_id, message, type, request_id) VALUES ($1, $2, $3, $4)`,
            [clientId, `Driver ${req.user.name} has accepted your pickup request and is on the way!`, 'request_accepted', requestId]
        );

        // Get updated request
        const result = await pool.query(`
            SELECT pr.*, u.name as client_name, u.phone as client_phone,
                   pr.shop_address as client_address, pr.pickup_lat as client_lat, pr.pickup_lng as client_lng
            FROM pickup_requests pr
            JOIN users u ON pr.client_id = u.id
            WHERE pr.id = $1
        `, [requestId]);

        const request = result.rows[0];

        // Real-time notification to client
        const io = req.app.get('io');
        if (io) {
            io.to(`user_${clientId}`).emit('request_update', {
                requestId: parseInt(requestId),
                status: 'assigned',
                driverName: req.user.name
            });
        }

        res.json({ request });
    } catch (err) {
        console.error('Accept request error:', err);
        res.status(500).json({ error: 'Failed to accept request' });
    }
});

// Mark in-transit
router.put('/requests/:id/transit', async (req, res) => {
    try {
        const pool = getDb();
        const requestId = req.params.id;

        const check = await pool.query(
            "SELECT id, status, client_id FROM pickup_requests WHERE id = $1 AND driver_id = $2",
            [requestId, req.user.id]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Request not found' });
        }

        const clientId = check.rows[0].client_id;

        await pool.query(
            "UPDATE pickup_requests SET status = 'in_transit', updated_at = NOW() WHERE id = $1",
            [requestId]
        );

        await pool.query(
            `INSERT INTO notifications (user_id, message, type, request_id) VALUES ($1, $2, $3, $4)`,
            [clientId, `Driver ${req.user.name} is on the way to your location!`, 'driver_enroute', requestId]
        );

        const io = req.app.get('io');
        if (io) {
            io.to(`user_${clientId}`).emit('request_update', {
                requestId: parseInt(requestId),
                status: 'in_transit',
                driverName: req.user.name
            });
        }

        res.json({ message: 'Status updated to in transit' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Complete a pickup with itemized collection
router.put('/requests/:id/complete', async (req, res) => {
    try {
        const pool = getDb();
        const requestId = req.params.id;
        const { items } = req.body;

        const check = await pool.query(
            "SELECT id, status, client_id, quantity_kg FROM pickup_requests WHERE id = $1 AND driver_id = $2",
            [requestId, req.user.id]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Request not found' });
        }

        const clientId = check.rows[0].client_id;
        const pickupQty = parseFloat(check.rows[0].quantity_kg || 0);

        // ===== VALID ITEM NAMES =====
        const VALID_ITEMS = [
            'Apple', 'Orange', 'Banana', 'Mango', 'Grape', 'Papaya', 'Guava', 'Pineapple', 'Watermelon', 'Pomegranate', 'Lemon', 'Coconut', 'Jackfruit', 'Sapota',
            'Tomato', 'Potato', 'Onion', 'Carrot', 'Cabbage', 'Spinach', 'Brinjal', 'Cauliflower', 'Beetroot', 'Radish', 'Beans', 'Capsicum', 'Cucumber', 'Pumpkin', 'Drumstick', 'Ladies Finger',
            'Turmeric', 'Ginger', 'Garlic', 'Chili', 'Coriander', 'Curry Leaves', 'Mint',
            'Sugarcane', 'Wheat', 'Rice', 'Corn', 'Millet',
            'Dairy Waste', 'Bread Waste', 'Cooked Food', 'Mixed Waste', 'Flower Waste', 'Leaf Waste'
        ];
        const VALID_ITEMS_LOWER = VALID_ITEMS.map(v => v.toLowerCase());

        function findClosestItem(input) {
            const inputLower = input.toLowerCase().trim();
            const exactIdx = VALID_ITEMS_LOWER.indexOf(inputLower);
            if (exactIdx !== -1) return { match: VALID_ITEMS[exactIdx], exact: true };
            for (let i = 0; i < VALID_ITEMS_LOWER.length; i++) {
                if (VALID_ITEMS_LOWER[i].includes(inputLower) || inputLower.includes(VALID_ITEMS_LOWER[i])) {
                    return { match: VALID_ITEMS[i], exact: false };
                }
            }
            return null;
        }

        if (items && Array.isArray(items) && items.length > 0) {
            const invalidItems = [];
            for (const item of items) {
                if (!item.item_name || !item.quantity_kg || item.quantity_kg <= 0) {
                    return res.status(400).json({ error: 'Each item must have a valid name and quantity > 0' });
                }
                const matched = findClosestItem(item.item_name);
                if (!matched) {
                    invalidItems.push(item.item_name);
                } else {
                    item.item_name = matched.match;
                }
            }
            if (invalidItems.length > 0) {
                return res.status(400).json({
                    error: `Invalid item name(s): ${invalidItems.join(', ')}. Use valid waste items like: ${VALID_ITEMS.slice(0, 10).join(', ')}...`,
                    valid_items: VALID_ITEMS
                });
            }
        }

        if (items && Array.isArray(items) && items.length > 0) {
            const totalCollected = items.reduce((sum, i) => sum + parseFloat(i.quantity_kg || 0), 0);
            if (totalCollected > pickupQty) {
                return res.status(400).json({
                    error: `Overcollection! You entered ${totalCollected.toFixed(1)}kg but only ${pickupQty}kg was requested.`
                });
            }
            if (totalCollected < pickupQty) {
                return res.status(400).json({
                    error: `Under-collected! You entered ${totalCollected.toFixed(1)}kg but ${pickupQty}kg was requested.`
                });
            }
        }

        await pool.query(
            "UPDATE pickup_requests SET status = 'completed', updated_at = NOW() WHERE id = $1",
            [requestId]
        );

        if (items && Array.isArray(items) && items.length > 0) {
            for (const item of items) {
                if (item.item_name && item.quantity_kg > 0) {
                    await pool.query(
                        `INSERT INTO collection_items (request_id, item_name, quantity_kg) VALUES ($1, $2, $3)`,
                        [requestId, item.item_name, item.quantity_kg]
                    );
                }
            }
        }

        // Auto-insert into inventory
        const reqInfo = await pool.query("SELECT shop_name FROM pickup_requests WHERE id = $1", [requestId]);
        const shopName = reqInfo.rows[0]?.shop_name || 'Unknown Shop';

        if (items && Array.isArray(items) && items.length > 0) {
            for (const item of items) {
                if (item.item_name && item.quantity_kg > 0) {
                    await pool.query(
                        `INSERT INTO inventory (request_id, item_name, quantity_kg, source_driver_id, source_shop_name, status) VALUES ($1, $2, $3, $4, $5, 'in_transit')`,
                        [requestId, item.item_name, item.quantity_kg, req.user.id, shopName]
                    );
                }
            }
        }

        let itemSummary = '';
        if (items && items.length > 0) {
            itemSummary = ' Items collected: ' + items.map(i => `${i.quantity_kg}kg ${i.item_name}`).join(', ') + '.';
        }

        await pool.query(
            `INSERT INTO notifications (user_id, message, type, request_id) VALUES ($1, $2, $3, $4)`,
            [clientId, `Your waste pickup has been completed by ${req.user.name}!${itemSummary} Thank you for recycling!`, 'request_completed', requestId]
        );

        const io = req.app.get('io');
        if (io) {
            io.to(`user_${clientId}`).emit('request_update', {
                requestId: parseInt(requestId),
                status: 'completed',
                driverName: req.user.name,
                items: items || []
            });
            io.emit('delivery_incoming', {
                driverName: req.user.name,
                itemSummary: itemSummary,
                requestId: parseInt(requestId)
            });
        }

        const PLANT_LOCATION = { lat: 11.0168, lng: 76.9558, name: 'GreenCycle Production Plant', address: 'SIDCO Industrial Estate, Coimbatore - 641021' };

        res.json({
            message: 'Pickup completed! Now deliver the goods to the production plant.',
            deliverToPlant: true,
            plant: PLANT_LOCATION,
            requestId: parseInt(requestId)
        });
    } catch (err) {
        console.error('Complete error:', err);
        res.status(500).json({ error: 'Failed to complete request' });
    }
});

// Get collection items for a request
router.get('/requests/:id/items', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(
            "SELECT * FROM collection_items WHERE request_id = $1 ORDER BY id",
            [req.params.id]
        );
        res.json({ items: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch collection items' });
    }
});

// ===== ARRIVED AT PLANT =====
router.put('/arrived-at-plant', async (req, res) => {
    try {
        const pool = getDb();

        const existing = await pool.query(
            "SELECT COUNT(*) as cnt FROM inventory WHERE source_driver_id = $1 AND status = 'in_transit'",
            [req.user.id]
        );
        const hasInTransit = parseInt(existing.rows[0].cnt) > 0;

        if (!hasInTransit) {
            const completedPickups = await pool.query(
                `SELECT pr.id as request_id, pr.shop_name, ci.item_name, ci.quantity_kg
                 FROM pickup_requests pr
                 JOIN collection_items ci ON ci.request_id = pr.id
                 WHERE pr.driver_id = $1 AND pr.status = 'completed'`,
                [req.user.id]
            );

            if (completedPickups.rows.length > 0) {
                for (const item of completedPickups.rows) {
                    const existsCheck = await pool.query(
                        "SELECT id FROM inventory WHERE request_id = $1 AND item_name = $2",
                        [item.request_id, item.item_name]
                    );
                    if (existsCheck.rows.length === 0) {
                        await pool.query(
                            `INSERT INTO inventory (request_id, item_name, quantity_kg, source_driver_id, source_shop_name, status, received_at, updated_at)
                             VALUES ($1, $2, $3, $4, $5, 'received', NOW(), NOW())`,
                            [item.request_id, item.item_name, item.quantity_kg, req.user.id, item.shop_name || 'Unknown']
                        );
                    }
                }
            } else {
                const pickups = await pool.query(
                    "SELECT id, waste_type, quantity_kg, shop_name FROM pickup_requests WHERE driver_id = $1 AND status = 'completed'",
                    [req.user.id]
                );
                for (const p of pickups.rows) {
                    const existsCheck = await pool.query(
                        "SELECT id FROM inventory WHERE request_id = $1 AND item_name = $2",
                        [p.id, p.waste_type]
                    );
                    if (existsCheck.rows.length === 0) {
                        await pool.query(
                            `INSERT INTO inventory (request_id, item_name, quantity_kg, source_driver_id, source_shop_name, status, received_at, updated_at)
                             VALUES ($1, $2, $3, $4, $5, 'received', NOW(), NOW())`,
                            [p.id, p.waste_type, p.quantity_kg, req.user.id, p.shop_name || 'Unknown']
                        );
                    }
                }
            }
        } else {
            await pool.query(
                "UPDATE inventory SET status = 'received', received_at = NOW(), updated_at = NOW() WHERE source_driver_id = $1 AND status = 'in_transit'",
                [req.user.id]
            );
        }

        await pool.query(
            "UPDATE pickup_requests SET status = 'delivered', updated_at = NOW() WHERE driver_id = $1 AND status = 'completed'",
            [req.user.id]
        );

        await pool.query("UPDATE users SET is_free = 1 WHERE id = $1", [req.user.id]);

        const io = req.app.get('io');
        if (io) {
            io.emit('driver_arrived', {
                driverId: req.user.id,
                driverName: req.user.name
            });
        }

        res.json({ message: 'Arrived at plant! Production employees have been notified. Wait for them to confirm goods receipt.' });
    } catch (err) {
        console.error('Plant arrival error:', err);
        res.status(500).json({ error: 'Failed to update arrival' });
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

// Driver stats
router.get('/stats', async (req, res) => {
    try {
        const pool = getDb();

        const assigned = await pool.query("SELECT COUNT(*) as c FROM pickup_requests WHERE driver_id = $1 AND status IN ('assigned','in_transit')", [req.user.id]);
        const completed = await pool.query("SELECT COUNT(*) as c FROM pickup_requests WHERE driver_id = $1 AND status = 'completed'", [req.user.id]);
        const totalKg = await pool.query("SELECT COALESCE(SUM(quantity_kg), 0) as c FROM pickup_requests WHERE driver_id = $1 AND status = 'completed'", [req.user.id]);
        const unreadNotifs = await pool.query("SELECT COUNT(*) as c FROM notifications WHERE user_id = $1 AND is_read = 0", [req.user.id]);

        res.json({
            stats: {
                activePickups: parseInt(assigned.rows[0].c) || 0,
                completed: parseInt(completed.rows[0].c) || 0,
                totalKgCollected: parseFloat(totalKg.rows[0].c) || 0,
                unreadNotifications: parseInt(unreadNotifs.rows[0].c) || 0
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

module.exports = router;
