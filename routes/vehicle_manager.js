const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

// Allow both vehicle_manager AND production_manager to access these routes
// (Production manager needs inventory, aggregation, predictions, send-to-production)
router.use((req, res, next) => {
    if (req.user.role !== 'vehicle_manager' && req.user.role !== 'production_manager') {
        return res.status(403).json({ error: 'Access denied. Vehicle manager or production manager role required.' });
    }
    next();
});

// ===== DASHBOARD STATS =====
router.get('/stats', async (req, res) => {
    try {
        const pool = getDb();
        const totalDrivers = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'driver'");
        const freeDrivers = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'driver' AND is_free = 1");
        const busyDrivers = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'driver' AND is_free = 0");
        const totalPickups = await pool.query("SELECT COUNT(*) as c FROM pickup_requests");
        const pendingPickups = await pool.query("SELECT COUNT(*) as c FROM pickup_requests WHERE status = 'pending'");
        const completedPickups = await pool.query("SELECT COUNT(*) as c FROM pickup_requests WHERE status IN ('completed','delivered')");
        const totalKg = await pool.query("SELECT COALESCE(SUM(quantity_kg),0) as c FROM pickup_requests WHERE status IN ('completed','delivered')");
        const inventoryItems = await pool.query("SELECT COUNT(*) as c FROM inventory WHERE status IN ('received','processing')");

        res.json({
            stats: {
                totalDrivers: parseInt(totalDrivers.rows[0].c) || 0,
                freeDrivers: parseInt(freeDrivers.rows[0].c) || 0,
                busyDrivers: parseInt(busyDrivers.rows[0].c) || 0,
                totalPickups: parseInt(totalPickups.rows[0].c) || 0,
                pendingPickups: parseInt(pendingPickups.rows[0].c) || 0,
                completedPickups: parseInt(completedPickups.rows[0].c) || 0,
                totalKgCollected: parseFloat(totalKg.rows[0].c) || 0,
                inventoryItems: parseInt(inventoryItems.rows[0].c) || 0
            }
        });
    } catch (err) {
        console.error('Vehicle manager stats error:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ===== DRIVERS LIST =====
router.get('/drivers', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT u.*, 
                (SELECT COUNT(*) FROM pickup_requests WHERE driver_id = u.id AND status IN ('assigned','in_transit')) as active_pickups,
                (SELECT COUNT(*) FROM pickup_requests WHERE driver_id = u.id AND status IN ('completed','delivered')) as completed_pickups,
                (SELECT COALESCE(SUM(quantity_kg),0) FROM pickup_requests WHERE driver_id = u.id AND status IN ('completed','delivered')) as total_kg
            FROM users u
            WHERE u.role = 'driver'
            ORDER BY u.name
        `);
        res.json({ drivers: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch drivers' });
    }
});

// ===== ALL PICKUP REQUESTS =====
router.get('/pickups', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT pr.*, c.name as client_name, c.phone as client_phone, c.shop_name,
                   d.name as driver_name, d.phone as driver_phone, d.vehicle_type
            FROM pickup_requests pr
            LEFT JOIN users c ON pr.client_id = c.id
            LEFT JOIN users d ON pr.driver_id = d.id
            ORDER BY pr.created_at DESC
        `);
        res.json({ pickups: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch pickups' });
    }
});

// ===== ASSIGN DRIVER =====
router.put('/pickups/:id/assign', async (req, res) => {
    try {
        const pool = getDb();
        const { driver_id } = req.body;

        if (!driver_id) return res.status(400).json({ error: 'Driver ID is required' });

        await pool.query("UPDATE pickup_requests SET driver_id = $1, status = 'assigned', updated_at = NOW() WHERE id = $2", [driver_id, req.params.id]);
        await pool.query("UPDATE users SET is_free = 0 WHERE id = $1", [driver_id]);

        const reqInfo = await pool.query("SELECT client_id FROM pickup_requests WHERE id = $1", [req.params.id]);
        if (reqInfo.rows.length > 0) {
            const clientId = reqInfo.rows[0].client_id;
            const driverInfo = await pool.query("SELECT name FROM users WHERE id = $1", [driver_id]);
            const driverName = driverInfo.rows[0]?.name || 'A driver';
            await pool.query("INSERT INTO notifications (user_id, message, type, request_id) VALUES ($1,$2,$3,$4)",
                [clientId, `${driverName} has been assigned for your pickup!`, 'driver_assigned', req.params.id]);
        }

        res.json({ message: 'Driver assigned successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to assign driver' });
    }
});

// ===== COLLECTION ITEMS =====
router.get('/pickups/:id/items', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query("SELECT * FROM collection_items WHERE request_id = $1 ORDER BY id", [req.params.id]);
        res.json({ items: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch items' });
    }
});

// ===== INVENTORY =====
router.get('/inventory', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT inv.*, d.name as driver_name
            FROM inventory inv
            LEFT JOIN users d ON inv.source_driver_id = d.id
            ORDER BY inv.received_at DESC
        `);
        res.json({ inventory: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch inventory' });
    }
});

// ===== UPDATE INVENTORY STATUS =====
router.put('/inventory/:id/status', async (req, res) => {
    try {
        const pool = getDb();
        const { status } = req.body;
        const validStatuses = ['received', 'processing', 'processed', 'dispatched', 'consumed'];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        await pool.query("UPDATE inventory SET status = $1, updated_at = NOW() WHERE id = $2", [status, req.params.id]);
        res.json({ message: `Inventory status updated to ${status}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update inventory status' });
    }
});

// ===== AI PRODUCT PREDICTION ENGINE (WASTE/SPOILED ITEMS) =====
const AI_KNOWLEDGE_BASE = {
    'apple': {
        products: [
            { product: 'Organic Compost Fertilizer', use: 'Decomposed rotten apple → nutrient-rich organic compost for agriculture', confidence: 'high', cost_per_kg: 45, sell_per_kg: 120, hours: 4, recipe: [{ item: 'Rotten Apple', kg: 20 }, { item: 'Cow Dung', kg: 5 }, { item: 'EM Solution', kg: 1 }, { item: 'Sawdust', kg: 3 }] },
            { product: 'Apple Cider Vinegar (Fermented)', use: 'Overripe apple fermentation → natural vinegar for health drinks & cleaning', confidence: 'high', cost_per_kg: 80, sell_per_kg: 280, hours: 8, recipe: [{ item: 'Spoiled Apple', kg: 15 }, { item: 'Water', kg: 10 }, { item: 'Sugar', kg: 2 }, { item: 'Yeast Culture', kg: 0.3 }] }
        ]
    },
    'orange': {
        products: [
            { product: 'Natural Orange Peel Dye', use: 'Dried old orange peel → natural textile dye & food coloring agent', confidence: 'high', cost_per_kg: 85, sell_per_kg: 250, hours: 6, recipe: [{ item: 'Waste Orange Peel', kg: 15 }, { item: 'Alum Mordant', kg: 2 }, { item: 'Water', kg: 10 }, { item: 'Salt', kg: 0.5 }] },
            { product: 'Citrus Bio-Cleaner', use: 'Rotten orange waste → eco-friendly cleaning agent with d-limonene', confidence: 'high', cost_per_kg: 60, sell_per_kg: 200, hours: 3, recipe: [{ item: 'Spoiled Orange', kg: 10 }, { item: 'Ethanol', kg: 2 }, { item: 'Distilled Water', kg: 5 }, { item: 'Baking Soda', kg: 0.5 }] }
        ]
    },
    'banana': {
        products: [
            { product: 'Biogas & Methane Fuel', use: 'Fermented rotten banana → biogas for energy generation via anaerobic digestion', confidence: 'high', cost_per_kg: 30, sell_per_kg: 90, hours: 8, recipe: [{ item: 'Rotten Banana', kg: 30 }, { item: 'Water', kg: 20 }, { item: 'Inoculum', kg: 2 }] },
            { product: 'Banana Fiber & Eco-Paper', use: 'Waste banana stem → natural fiber extraction for eco-friendly paper & packaging', confidence: 'high', cost_per_kg: 150, sell_per_kg: 450, hours: 10, recipe: [{ item: 'Banana Stem Waste', kg: 15 }, { item: 'Sodium Hydroxide', kg: 0.5 }, { item: 'Water', kg: 25 }, { item: 'Bleach', kg: 0.3 }] }
        ]
    },
    'tomato': {
        products: [
            { product: 'Lycopene Extract (Cosmetics)', use: 'Waste tomato skin → lycopene for anti-aging cream & dietary supplements', confidence: 'high', cost_per_kg: 180, sell_per_kg: 650, hours: 10, recipe: [{ item: 'Rotten Tomato Skin', kg: 15 }, { item: 'Ethanol', kg: 3 }, { item: 'Filter Aid', kg: 0.5 }] },
            { product: 'Organic Tomato Fertilizer', use: 'Decomposed stale tomato → calcium-rich fertilizer for plants', confidence: 'high', cost_per_kg: 35, sell_per_kg: 100, hours: 3, recipe: [{ item: 'Stale Tomato', kg: 20 }, { item: 'Wood Ash', kg: 3 }, { item: 'EM Solution', kg: 1 }] }
        ]
    },
    'mango': { products: [{ product: 'Mango Seed Oil & Butter', use: 'Overripe mango seed → mango butter for cosmetics & skincare', confidence: 'high', cost_per_kg: 200, sell_per_kg: 700, hours: 6, recipe: [{ item: 'Mango Seed Waste', kg: 12 }, { item: 'Cold Press Solvent', kg: 1 }, { item: 'Filter Medium', kg: 0.5 }] }] },
    'potato': {
        products: [
            { product: 'Bio-Starch & Biodegradable Plastic', use: 'Spoiled old potato → starch extraction for eco-packaging & paper glue', confidence: 'high', cost_per_kg: 60, sell_per_kg: 180, hours: 5, recipe: [{ item: 'Waste Potato', kg: 25 }, { item: 'Water', kg: 15 }, { item: 'Glycerin', kg: 0.5 }] },
            { product: 'Potato Ethanol Fuel', use: 'Fermented rotten potato → bioethanol for eco-fuel', confidence: 'medium', cost_per_kg: 40, sell_per_kg: 130, hours: 12, recipe: [{ item: 'Rotten Potato', kg: 20 }, { item: 'Yeast', kg: 1 }, { item: 'Water', kg: 15 }, { item: 'Amylase', kg: 0.5 }] }
        ]
    },
    'grape': { products: [{ product: 'Grape Seed Extract & Oil', use: 'Waste grape seed → antioxidant extract for cosmetics & supplements', confidence: 'high', cost_per_kg: 220, sell_per_kg: 900, hours: 8, recipe: [{ item: 'Waste Grape Seeds', kg: 10 }, { item: 'Ethanol', kg: 3 }, { item: 'Cold Press Oil', kg: 0.5 }] }] },
    'coconut': {
        products: [
            { product: 'Coir Fiber & Rope', use: 'Waste coconut husk → coir fiber for ropes, mats, mattress filling', confidence: 'high', cost_per_kg: 50, sell_per_kg: 150, hours: 4, recipe: [{ item: 'Coconut Husk Waste', kg: 15 }, { item: 'Water', kg: 20 }, { item: 'Salt', kg: 1 }] },
            { product: 'Activated Charcoal', use: 'Waste coconut shell → activated carbon for water purification & cosmetics', confidence: 'high', cost_per_kg: 120, sell_per_kg: 500, hours: 6, recipe: [{ item: 'Coconut Shell Waste', kg: 10 }, { item: 'Phosphoric Acid', kg: 1 }, { item: 'Heat Fuel', kg: 2 }] }
        ]
    },
    'spinach': { products: [{ product: 'Chlorophyll Green Dye', use: 'Wilted spinach → natural green dye for textiles & food coloring', confidence: 'high', cost_per_kg: 140, sell_per_kg: 500, hours: 3, recipe: [{ item: 'Wilted Spinach', kg: 12 }, { item: 'Ethanol', kg: 2 }, { item: 'Water', kg: 5 }] }] },
    'turmeric': { products: [{ product: 'Curcumin Supplement & Natural Dye', use: 'Old waste turmeric → curcumin extract for medicine & natural yellow dye', confidence: 'high', cost_per_kg: 250, sell_per_kg: 1200, hours: 12, recipe: [{ item: 'Waste Turmeric', kg: 8 }, { item: 'Ethanol', kg: 3 }, { item: 'Black Pepper Extract', kg: 0.1 }] }] },
    'ginger': { products: [{ product: 'Ginger Essential Oil', use: 'Old dried ginger waste → essential oil for ayurvedic medicine & aromatherapy', confidence: 'high', cost_per_kg: 160, sell_per_kg: 500, hours: 6, recipe: [{ item: 'Ginger Waste', kg: 10 }, { item: 'Ethanol', kg: 2 }, { item: 'Water', kg: 5 }] }] },
    'lemon': { products: [{ product: 'Citric Acid & Cleaning Agent', use: 'Waste lemon peel → citric acid for food preservative & eco-cleaning products', confidence: 'high', cost_per_kg: 130, sell_per_kg: 400, hours: 6, recipe: [{ item: 'Lemon Peel Waste', kg: 15 }, { item: 'Water', kg: 8 }, { item: 'Ethanol', kg: 2 }] }] },
    'onion': { products: [{ product: 'Onion Skin Natural Dye', use: 'Waste onion skins → natural yellow/brown dye for textiles', confidence: 'high', cost_per_kg: 70, sell_per_kg: 220, hours: 3, recipe: [{ item: 'Onion Skin Waste', kg: 8 }, { item: 'Alum', kg: 1 }, { item: 'Water', kg: 15 }] }] },
    'cabbage': { products: [{ product: 'Natural pH Indicator Strips', use: 'Rotted cabbage → extract for pH indicator paper (science labs)', confidence: 'medium', cost_per_kg: 100, sell_per_kg: 350, hours: 4, recipe: [{ item: 'Cabbage Waste', kg: 10 }, { item: 'Water', kg: 8 }, { item: 'Filter Paper', kg: 2 }] }] },
    'sugarcane': {
        products: [
            { product: 'Bagasse Paper & Plates', use: 'Sugarcane bagasse waste → eco-friendly plates, bowls & paper products', confidence: 'high', cost_per_kg: 55, sell_per_kg: 170, hours: 5, recipe: [{ item: 'Sugarcane Bagasse', kg: 15 }, { item: 'Sodium Hydroxide', kg: 0.5 }, { item: 'Water', kg: 20 }] },
            { product: 'Bagasse Bioethanol', use: 'Fermented sugarcane waste → bioethanol fuel for vehicles', confidence: 'high', cost_per_kg: 40, sell_per_kg: 120, hours: 10, recipe: [{ item: 'Sugarcane Bagasse', kg: 20 }, { item: 'Yeast', kg: 1 }, { item: 'Water', kg: 15 }, { item: 'Acid', kg: 0.3 }] }
        ]
    },
    'carrot': { products: [{ product: 'Beta-Carotene Powder', use: 'Old dried carrot peels → natural orange food coloring & supplements', confidence: 'high', cost_per_kg: 160, sell_per_kg: 550, hours: 5, recipe: [{ item: 'Carrot Peel Waste', kg: 12 }, { item: 'Ethanol', kg: 2 }, { item: 'Drying Agent', kg: 0.5 }] }] },
    'rice': { products: [{ product: 'Rice Husk Ash (Silica)', use: 'Waste rice husk → silica ash for cement & fertilizer additive', confidence: 'medium', cost_per_kg: 25, sell_per_kg: 70, hours: 4, recipe: [{ item: 'Rice Husk Waste', kg: 15 }, { item: 'Heat Fuel', kg: 2 }] }] },
    'wheat': { products: [{ product: 'Wheat Bran Animal Feed', use: 'Old stale wheat waste → nutrient-rich livestock feed supplement', confidence: 'medium', cost_per_kg: 20, sell_per_kg: 55, hours: 2, recipe: [{ item: 'Stale Wheat Waste', kg: 20 }, { item: 'Mineral Mix', kg: 1 }, { item: 'Molasses', kg: 2 }] }] },
    'chili': { products: [{ product: 'Capsaicin Extract (Pain Relief)', use: 'Dried old chili waste → capsaicin for pain relief creams & pest repellent', confidence: 'medium', cost_per_kg: 180, sell_per_kg: 600, hours: 8, recipe: [{ item: 'Dried Chili Waste', kg: 5 }, { item: 'Ethanol', kg: 3 }, { item: 'Carrier Oil', kg: 2 }] }] },
    'pineapple': { products: [{ product: 'Bromelain Enzyme', use: 'Overripe pineapple waste → digestive enzyme for supplements & meat tenderizer', confidence: 'high', cost_per_kg: 200, sell_per_kg: 800, hours: 10, recipe: [{ item: 'Pineapple Waste', kg: 15 }, { item: 'Ammonium Sulfate', kg: 1 }, { item: 'Cold Water', kg: 10 }] }] },
    'corn': {
        products: [
            { product: 'Biodegradable Carry Bags (Corn Starch)', use: 'Waste corn → corn starch extraction → biodegradable carry bags & packaging', confidence: 'high', cost_per_kg: 90, sell_per_kg: 320, hours: 8, recipe: [{ item: 'Waste Corn', kg: 20 }, { item: 'Glycerin', kg: 2 }, { item: 'Vinegar (Acetic Acid)', kg: 1 }, { item: 'Water', kg: 10 }, { item: 'PLA Polymer Pellets', kg: 3 }] },
            { product: 'Corn Ethanol Biofuel', use: 'Fermented spoiled corn → bioethanol for eco-fuel blending', confidence: 'high', cost_per_kg: 45, sell_per_kg: 140, hours: 12, recipe: [{ item: 'Rotten Corn', kg: 25 }, { item: 'Yeast', kg: 1 }, { item: 'Water', kg: 20 }, { item: 'Amylase Enzyme', kg: 0.5 }] }
        ]
    },
    'beetroot': { products: [{ product: 'Natural Red Dye (Betanin)', use: 'Waste beetroot → natural red food coloring & textile dye', confidence: 'high', cost_per_kg: 130, sell_per_kg: 450, hours: 5, recipe: [{ item: 'Beetroot Waste', kg: 12 }, { item: 'Citric Acid', kg: 0.5 }, { item: 'Ethanol', kg: 2 }, { item: 'Water', kg: 8 }] }] },
    'beans': { products: [{ product: 'Protein-Rich Animal Feed', use: 'Old spoiled beans → high-protein animal feed supplement', confidence: 'high', cost_per_kg: 25, sell_per_kg: 75, hours: 3, recipe: [{ item: 'Spoiled Beans', kg: 15 }, { item: 'Mineral Mix', kg: 1 }, { item: 'Molasses', kg: 2 }] }] },
    'capsicum': { products: [{ product: 'Capsaicin Pest Repellent Spray', use: 'Waste capsicum → natural pest repellent for organic farming', confidence: 'high', cost_per_kg: 100, sell_per_kg: 350, hours: 4, recipe: [{ item: 'Capsicum Waste', kg: 8 }, { item: 'Garlic Extract', kg: 1 }, { item: 'Neem Oil', kg: 0.5 }, { item: 'Water', kg: 10 }] }] },
    'cucumber': { products: [{ product: 'Cucumber Face Pack & Toner', use: 'Overripe cucumber → natural skin toner & cooling face pack', confidence: 'medium', cost_per_kg: 80, sell_per_kg: 250, hours: 3, recipe: [{ item: 'Cucumber Waste', kg: 10 }, { item: 'Aloe Vera Gel', kg: 2 }, { item: 'Rose Water', kg: 1 }, { item: 'Glycerin', kg: 0.5 }] }] },
    'garlic': { products: [{ product: 'Garlic Bio-Pesticide', use: 'Waste garlic → organic pesticide concentrate for crop protection', confidence: 'high', cost_per_kg: 90, sell_per_kg: 300, hours: 4, recipe: [{ item: 'Garlic Waste', kg: 8 }, { item: 'Neem Oil', kg: 1 }, { item: 'Soap Liquid', kg: 0.5 }, { item: 'Water', kg: 10 }] }] },
    'papaya': { products: [{ product: 'Papain Enzyme (Meat Tenderizer)', use: 'Waste unripe papaya → papain enzyme for food industry & medicine', confidence: 'high', cost_per_kg: 180, sell_per_kg: 700, hours: 8, recipe: [{ item: 'Papaya Waste', kg: 12 }, { item: 'Sodium Chloride', kg: 0.5 }, { item: 'Ethanol', kg: 2 }, { item: 'Water', kg: 5 }] }] },
    'guava': { products: [{ product: 'Guava Leaf Herbal Tea Extract', use: 'Waste guava leaves & fruit → herbal tea with anti-diabetic properties', confidence: 'medium', cost_per_kg: 110, sell_per_kg: 380, hours: 4, recipe: [{ item: 'Guava Waste', kg: 10 }, { item: 'Water', kg: 8 }, { item: 'Honey', kg: 0.5 }] }] },
    'watermelon': { products: [{ product: 'Watermelon Rind Pickles & Preserves', use: 'Waste watermelon rind → preserved food with L-citrulline health benefits', confidence: 'medium', cost_per_kg: 40, sell_per_kg: 120, hours: 3, recipe: [{ item: 'Watermelon Rind', kg: 15 }, { item: 'Vinegar', kg: 2 }, { item: 'Sugar', kg: 3 }, { item: 'Salt', kg: 0.5 }] }] },
    'radish': { products: [{ product: 'Radish Bio-Enzyme Cleaner', use: 'Rotting radish → enzyme cleaner for household use via fermentation', confidence: 'medium', cost_per_kg: 35, sell_per_kg: 100, hours: 5, recipe: [{ item: 'Radish Waste', kg: 10 }, { item: 'Jaggery', kg: 3 }, { item: 'Water', kg: 15 }] }] },
    'cauliflower': { products: [{ product: 'Organic Leaf Compost', use: 'Waste cauliflower leaves → premium compost for garden & nursery', confidence: 'high', cost_per_kg: 30, sell_per_kg: 85, hours: 4, recipe: [{ item: 'Cauliflower Waste', kg: 15 }, { item: 'Cow Dung', kg: 5 }, { item: 'EM Solution', kg: 1 }] }] },
    'brinjal': { products: [{ product: 'Nasunin Extract (Antioxidant)', use: 'Waste brinjal skin → nasunin antioxidant for health supplements', confidence: 'medium', cost_per_kg: 150, sell_per_kg: 500, hours: 6, recipe: [{ item: 'Brinjal Skin Waste', kg: 10 }, { item: 'Ethanol', kg: 2 }, { item: 'Water', kg: 5 }] }] },
    'pumpkin': { products: [{ product: 'Pumpkin Seed Oil', use: 'Waste pumpkin seeds → cold-pressed oil for cooking & cosmetics', confidence: 'high', cost_per_kg: 170, sell_per_kg: 550, hours: 5, recipe: [{ item: 'Pumpkin Seed Waste', kg: 10 }, { item: 'Cold Press Solvent', kg: 0.5 }, { item: 'Filter Medium', kg: 0.3 }] }] },
    'drumstick': { products: [{ product: 'Moringa Leaf Powder (Superfood)', use: 'Waste moringa/drumstick leaves → dried nutrient-rich powder for health food', confidence: 'high', cost_per_kg: 120, sell_per_kg: 400, hours: 3, recipe: [{ item: 'Drumstick Waste', kg: 12 }, { item: 'Drying Agent', kg: 0.5 }] }] },
    'coriander': { products: [{ product: 'Coriander Essential Oil', use: 'Wilted coriander → essential oil for food flavoring & aromatherapy', confidence: 'medium', cost_per_kg: 140, sell_per_kg: 480, hours: 5, recipe: [{ item: 'Coriander Waste', kg: 8 }, { item: 'Steam Water', kg: 10 }, { item: 'Collection Flask', kg: 0.1 }] }] },
    'curry leaves': { products: [{ product: 'Curry Leaf Hair Oil Extract', use: 'Dried waste curry leaves → hair growth oil extract for cosmetics', confidence: 'high', cost_per_kg: 130, sell_per_kg: 420, hours: 4, recipe: [{ item: 'Curry Leaf Waste', kg: 5 }, { item: 'Coconut Oil', kg: 8 }, { item: 'Fenugreek', kg: 0.5 }] }] },
    'mint': { products: [{ product: 'Menthol Crystal Extract', use: 'Waste mint → menthol crystals for medicine, balm & toothpaste', confidence: 'high', cost_per_kg: 200, sell_per_kg: 750, hours: 6, recipe: [{ item: 'Mint Waste', kg: 10 }, { item: 'Ethanol', kg: 3 }, { item: 'Cooling Agent', kg: 0.5 }] }] },
    'millet': { products: [{ product: 'Millet Husk Bio-Board', use: 'Waste millet husk → eco-friendly building board & insulation panel', confidence: 'medium', cost_per_kg: 40, sell_per_kg: 130, hours: 6, recipe: [{ item: 'Millet Husk Waste', kg: 15 }, { item: 'Natural Resin Binder', kg: 3 }, { item: 'Water', kg: 5 }] }] },
    'dairy waste': { products: [{ product: 'Casein Bio-Plastic', use: 'Expired dairy → casein protein extraction for biodegradable plastic', confidence: 'medium', cost_per_kg: 70, sell_per_kg: 220, hours: 6, recipe: [{ item: 'Dairy Waste', kg: 15 }, { item: 'Vinegar', kg: 2 }, { item: 'Glycerin', kg: 1 }, { item: 'Water', kg: 10 }] }] },
    'bread waste': { products: [{ product: 'Bioethanol from Bread', use: 'Stale bread waste → fermented bioethanol for eco-fuel', confidence: 'high', cost_per_kg: 35, sell_per_kg: 110, hours: 10, recipe: [{ item: 'Bread Waste', kg: 20 }, { item: 'Yeast', kg: 1 }, { item: 'Water', kg: 15 }] }] },
    'cooked food': { products: [{ product: 'Biogas & Organic Slurry', use: 'Cooked food waste → biogas via anaerobic digester + organic fertilizer slurry', confidence: 'high', cost_per_kg: 25, sell_per_kg: 70, hours: 8, recipe: [{ item: 'Cooked Food Waste', kg: 25 }, { item: 'Water', kg: 15 }, { item: 'Inoculum', kg: 2 }] }] },
    'flower waste': { products: [{ product: 'Incense Sticks (Agarbatti)', use: 'Temple/market flower waste → natural incense sticks & dhoop', confidence: 'high', cost_per_kg: 60, sell_per_kg: 200, hours: 4, recipe: [{ item: 'Flower Waste', kg: 10 }, { item: 'Charcoal Powder', kg: 3 }, { item: 'Natural Binder (Jigat)', kg: 1 }, { item: 'Essential Oil', kg: 0.3 }] }] },
    'leaf waste': { products: [{ product: 'Leaf Mold Compost', use: 'Dried fallen leaves → leaf mold compost for garden & nursery soil', confidence: 'high', cost_per_kg: 20, sell_per_kg: 60, hours: 3, recipe: [{ item: 'Leaf Waste', kg: 20 }, { item: 'Water', kg: 10 }, { item: 'Nitrogen Source (Urea)', kg: 0.5 }] }] },
    'mixed waste': { products: [{ product: 'Vermicompost (Premium)', use: 'Mixed organic waste → vermicomposting with earthworms for premium soil additive', confidence: 'high', cost_per_kg: 40, sell_per_kg: 110, hours: 5, recipe: [{ item: 'Mixed Waste', kg: 20 }, { item: 'Earthworms', kg: 0.5 }, { item: 'Cow Dung', kg: 5 }, { item: 'Coco Peat', kg: 3 }] }] },
    'pomegranate': { products: [{ product: 'Pomegranate Peel Extract (Antioxidant)', use: 'Waste pomegranate peel → punicalagin extract for cosmetics & supplements', confidence: 'high', cost_per_kg: 190, sell_per_kg: 750, hours: 7, recipe: [{ item: 'Pomegranate Peel Waste', kg: 10 }, { item: 'Ethanol', kg: 3 }, { item: 'Water', kg: 5 }] }] },
    'jackfruit': { products: [{ product: 'Jackfruit Latex Adhesive', use: 'Waste jackfruit rind → natural adhesive for paper & wood industry', confidence: 'medium', cost_per_kg: 50, sell_per_kg: 160, hours: 4, recipe: [{ item: 'Jackfruit Rind Waste', kg: 12 }, { item: 'Calcium Hydroxide', kg: 1 }, { item: 'Water', kg: 5 }] }] }
};

const DEFAULT_PREDICTION = {
    products: [
        { product: 'Organic Compost & Biogas', use: 'Mixed waste decomposition → compost for soil enrichment + anaerobic digestion for biogas energy', confidence: 'medium', cost_per_kg: 30, sell_per_kg: 80, hours: 6, recipe: [{ item: 'Mixed Waste', kg: 20 }, { item: 'EM Solution', kg: 1 }, { item: 'Cow Dung', kg: 5 }, { item: 'Water', kg: 10 }] }
    ]
};

// ===== COMBINED PREDICTIONS =====
const COMBINED_PREDICTIONS = [
    { items: ['banana', 'corn'], product: 'Bio-Degradable Food Packaging', use: 'Banana fiber + corn starch → biodegradable food containers & wrapping film', confidence: 'high', cost_per_kg: 80, sell_per_kg: 300, hours: 10, recipe: [{ item: 'Banana Fiber Waste', kg: 12 }, { item: 'Corn Starch Waste', kg: 10 }, { item: 'Glycerin', kg: 2 }, { item: 'PLA Resin', kg: 3 }, { item: 'Water', kg: 8 }] },
    { items: ['spinach', 'turmeric'], product: 'Herbal Health Supplement Powder', use: 'Chlorophyll from wilted spinach + curcumin from old turmeric → natural antioxidant health supplement', confidence: 'high', cost_per_kg: 200, sell_per_kg: 800, hours: 8, recipe: [{ item: 'Wilted Spinach Waste', kg: 10 }, { item: 'Old Turmeric Waste', kg: 5 }, { item: 'Black Pepper Extract', kg: 0.2 }, { item: 'Moringa Powder', kg: 1 }] },
    { items: ['orange', 'lemon'], product: 'Citrus Bio-Cleaning Concentrate', use: 'Waste orange + lemon peels → powerful d-limonene based eco-cleaning solution', confidence: 'high', cost_per_kg: 70, sell_per_kg: 250, hours: 4, recipe: [{ item: 'Orange Peel Waste', kg: 10 }, { item: 'Lemon Peel Waste', kg: 8 }, { item: 'Ethanol', kg: 2 }, { item: 'Baking Soda', kg: 0.5 }, { item: 'Water', kg: 5 }] },
    { items: ['potato', 'corn'], product: 'Biodegradable Carry Bags (Advanced)', use: 'Potato starch + corn starch → stronger biodegradable carry bags', confidence: 'high', cost_per_kg: 85, sell_per_kg: 350, hours: 8, recipe: [{ item: 'Waste Potato Starch', kg: 12 }, { item: 'Waste Corn Starch', kg: 10 }, { item: 'Glycerin', kg: 2 }, { item: 'Vinegar', kg: 1 }, { item: 'PLA Pellets', kg: 3 }] },
    { items: ['apple', 'grape'], product: 'Premium Organic Vinegar Blend', use: 'Spoiled apple + grape fermentation → artisan organic vinegar', confidence: 'high', cost_per_kg: 120, sell_per_kg: 450, hours: 12, recipe: [{ item: 'Spoiled Apple Waste', kg: 10 }, { item: 'Grape Waste', kg: 8 }, { item: 'Sugar', kg: 1 }, { item: 'Yeast Culture', kg: 0.5 }, { item: 'Water', kg: 10 }] },
    { items: ['tomato', 'chili'], product: 'Natural Pest Repellent Spray', use: 'Capsaicin from waste chili + lycopene from spoiled tomato → organic pest deterrent', confidence: 'high', cost_per_kg: 110, sell_per_kg: 400, hours: 5, recipe: [{ item: 'Rotten Tomato Waste', kg: 10 }, { item: 'Dried Chili Waste', kg: 5 }, { item: 'Garlic Extract', kg: 1 }, { item: 'Neem Oil', kg: 1 }, { item: 'Water', kg: 8 }] },
    { items: ['coconut', 'sugarcane'], product: 'Eco-Fiber Composite Board', use: 'Coconut coir fiber + sugarcane bagasse → construction-grade eco-board', confidence: 'high', cost_per_kg: 65, sell_per_kg: 200, hours: 6, recipe: [{ item: 'Coconut Husk Waste', kg: 12 }, { item: 'Sugarcane Bagasse', kg: 10 }, { item: 'Natural Resin', kg: 3 }, { item: 'Water', kg: 5 }] },
    { items: ['mango', 'papaya'], product: 'Tropical Enzyme Face Wash', use: 'Papain from waste papaya + mango butter → premium natural exfoliating face wash', confidence: 'high', cost_per_kg: 250, sell_per_kg: 1000, hours: 6, recipe: [{ item: 'Papaya Waste', kg: 8 }, { item: 'Mango Waste', kg: 6 }, { item: 'Aloe Vera Gel', kg: 2 }, { item: 'Essential Oil', kg: 0.3 }, { item: 'Glycerin', kg: 1 }] },
    { items: ['onion', 'garlic'], product: 'Bio-Organic Fungicide', use: 'Allicin from waste garlic + quercetin from onion skin → organic anti-fungal spray', confidence: 'high', cost_per_kg: 100, sell_per_kg: 380, hours: 4, recipe: [{ item: 'Onion Skin Waste', kg: 8 }, { item: 'Garlic Waste', kg: 6 }, { item: 'Water', kg: 10 }, { item: 'Soap Solution', kg: 0.5 }] },
    { items: ['ginger', 'turmeric'], product: 'Ayurvedic Pain Relief Balm', use: 'Gingerol from ginger + curcumin from turmeric → traditional pain relief balm', confidence: 'high', cost_per_kg: 180, sell_per_kg: 700, hours: 6, recipe: [{ item: 'Ginger Waste', kg: 8 }, { item: 'Turmeric Waste', kg: 5 }, { item: 'Beeswax', kg: 2 }, { item: 'Camphor', kg: 0.5 }, { item: 'Coconut Oil', kg: 3 }] },
    { items: ['beetroot', 'carrot'], product: 'Natural Food Coloring Set (Red+Orange)', use: 'Betanin from beetroot + beta-carotene from carrot → natural food coloring duo', confidence: 'high', cost_per_kg: 160, sell_per_kg: 600, hours: 5, recipe: [{ item: 'Beetroot Waste', kg: 8 }, { item: 'Carrot Waste', kg: 8 }, { item: 'Citric Acid', kg: 0.5 }, { item: 'Ethanol', kg: 2 }] },
    { items: ['banana', 'sugarcane'], product: 'Eco-Friendly Disposable Plates', use: 'Banana leaf fiber + sugarcane bagasse → biodegradable plates & bowls', confidence: 'high', cost_per_kg: 55, sell_per_kg: 180, hours: 5, recipe: [{ item: 'Banana Stem Waste', kg: 12 }, { item: 'Sugarcane Bagasse', kg: 10 }, { item: 'Sodium Hydroxide', kg: 0.3 }, { item: 'Water', kg: 15 }] },
    { items: ['rice', 'wheat'], product: 'Bio-Composite Animal Feed Pellets', use: 'Rice husk + wheat bran → high-nutrition animal feed pellets', confidence: 'high', cost_per_kg: 25, sell_per_kg: 75, hours: 3, recipe: [{ item: 'Rice Husk Waste', kg: 12 }, { item: 'Stale Wheat Waste', kg: 10 }, { item: 'Molasses', kg: 2 }, { item: 'Mineral Mix', kg: 1 }] },
    { items: ['pineapple', 'papaya'], product: 'Dual-Enzyme Digestive Supplement', use: 'Bromelain from pineapple + papain from papaya → premium digestive enzyme blend', confidence: 'high', cost_per_kg: 280, sell_per_kg: 1100, hours: 10, recipe: [{ item: 'Pineapple Waste', kg: 10 }, { item: 'Papaya Waste', kg: 8 }, { item: 'Ammonium Sulfate', kg: 0.5 }, { item: 'Cold Water', kg: 8 }] },
    { items: ['mint', 'ginger'], product: 'Herbal Throat Lozenge Base', use: 'Menthol from mint + gingerol from ginger → natural throat soothing lozenge', confidence: 'high', cost_per_kg: 200, sell_per_kg: 800, hours: 6, recipe: [{ item: 'Mint Waste', kg: 8 }, { item: 'Ginger Waste', kg: 5 }, { item: 'Honey', kg: 2 }, { item: 'Pectin', kg: 1 }] },
    { items: ['spinach', 'beetroot', 'carrot'], product: 'Triple-Superfood Powder Mix', use: 'Iron from spinach + betanin from beetroot + beta-carotene from carrot → premium health powder', confidence: 'high', cost_per_kg: 190, sell_per_kg: 750, hours: 6, recipe: [{ item: 'Wilted Spinach Waste', kg: 8 }, { item: 'Beetroot Waste', kg: 6 }, { item: 'Carrot Waste', kg: 6 }, { item: 'Drying Agent', kg: 0.5 }] },
    { items: ['curry leaves', 'coconut'], product: 'Premium Herbal Hair Oil', use: 'Curry leaf extract + coconut oil base → traditional South Indian hair growth oil', confidence: 'high', cost_per_kg: 140, sell_per_kg: 480, hours: 4, recipe: [{ item: 'Curry Leaf Waste', kg: 5 }, { item: 'Coconut Waste Oil', kg: 10 }, { item: 'Fenugreek', kg: 0.5 }, { item: 'Amla Extract', kg: 1 }] },
    { items: ['flower waste', 'coriander', 'mint'], product: 'Natural Room Freshener & Incense', use: 'Flower petals + coriander + mint → eco-friendly room freshener cones', confidence: 'medium', cost_per_kg: 90, sell_per_kg: 320, hours: 4, recipe: [{ item: 'Flower Waste', kg: 8 }, { item: 'Coriander Waste', kg: 3 }, { item: 'Mint Waste', kg: 3 }, { item: 'Charcoal Powder', kg: 2 }, { item: 'Essential Oil Base', kg: 0.5 }] }
];

const RAW_WASTE_NAMES = [
    'apple', 'banana', 'orange', 'mango', 'grape', 'tomato', 'potato', 'onion', 'carrot', 'cabbage', 'spinach',
    'turmeric', 'ginger', 'lemon', 'sugarcane', 'coconut', 'chili', 'pineapple', 'corn', 'beetroot', 'beans',
    'capsicum', 'cucumber', 'garlic', 'papaya', 'guava', 'watermelon', 'radish', 'cauliflower', 'brinjal',
    'pumpkin', 'drumstick', 'coriander', 'curry leaves', 'mint', 'millet', 'rice', 'wheat', 'pomegranate', 'jackfruit'
];

function getAIPrediction(itemName) {
    const key = itemName.toLowerCase().trim();
    for (const [k, v] of Object.entries(AI_KNOWLEDGE_BASE)) {
        if (key.includes(k) || k.includes(key)) return { ...v, matched_key: k };
    }
    return { ...DEFAULT_PREDICTION, matched_key: 'general_waste' };
}

function validateProductName(productName, wasteItemName) {
    const pLower = productName.toLowerCase().trim();
    const wLower = wasteItemName.toLowerCase().trim();
    if (RAW_WASTE_NAMES.some(r => pLower === r || pLower === r + 's' || pLower === 'old ' + r || pLower === 'rotten ' + r || pLower === 'waste ' + r)) {
        return { valid: false, error: `"${productName}" is a raw waste item, not a manufactured product.` };
    }
    if (pLower === wLower || pLower.replace(/[^a-z]/g, '') === wLower.replace(/[^a-z]/g, '')) {
        return { valid: false, error: `Product cannot be the same as the waste item "${wasteItemName}".` };
    }
    if (pLower.length < 4) return { valid: false, error: 'Product name must be at least 4 characters long.' };
    return { valid: true };
}

function aiEstimateForHuman(recipe, wasteItemName) {
    const numIngredients = recipe.length;
    const totalKg = recipe.reduce((s, r) => s + (r.kg || 0), 0);
    const wasteKg = recipe.filter(r => { const rl = r.item.toLowerCase(); return RAW_WASTE_NAMES.some(w => rl.includes(w)) || rl.includes('waste') || rl.includes('rotten') || rl.includes('spoiled'); }).reduce((s, r) => s + r.kg, 0);
    const extraKg = totalKg - wasteKg;
    const costPerKg = Math.round(40 + extraKg * 15 + numIngredients * 10);
    const sellPerKg = Math.round(costPerKg * (2.0 + Math.random() * 1.5));
    const hours = Math.round(3 + numIngredients * 0.8 + extraKg * 0.3);
    return { cost_per_kg: costPerKg, sell_per_kg: sellPerKg, hours: Math.min(hours, 24) };
}

function getCombinedPredictions(availableItems) {
    const availableKeys = availableItems.map(i => i.toLowerCase().trim());
    const results = [];
    COMBINED_PREDICTIONS.forEach(cp => {
        const match = cp.items.every(item => availableKeys.some(ak => ak.includes(item) || item.includes(ak)));
        if (match) {
            const wasteIng = [], extraMat = [];
            let extraCost = 0;
            cp.recipe.forEach(r => {
                const rLower = r.item.toLowerCase();
                const isWaste = RAW_WASTE_NAMES.some(w => rLower.includes(w)) || rLower.includes('waste') || rLower.includes('rotten') || rLower.includes('spoiled') || rLower.includes('stale') || rLower.includes('wilted');
                if (isWaste) { wasteIng.push({ ...r, cost: 0, source: '♻️ From waste' }); }
                else { const cost = Math.round(r.kg * (cp.cost_per_kg * 0.3)); extraCost += cost; extraMat.push({ ...r, cost, source: '🛒 Purchase' }); }
            });
            results.push({
                items_combined: cp.items, product: cp.product, use: cp.use, confidence: cp.confidence,
                cost_per_kg: cp.cost_per_kg, sell_per_kg: cp.sell_per_kg,
                profit_per_kg: cp.sell_per_kg - cp.cost_per_kg,
                profit_margin: Math.round((cp.sell_per_kg - cp.cost_per_kg) / cp.sell_per_kg * 100) + '%',
                hours: cp.hours, waste_ingredients: wasteIng, extra_materials: extraMat, extra_materials_cost: extraCost, recipe: cp.recipe
            });
        }
    });
    return results;
}

async function getBaseInvestment(pool) {
    const result = await pool.query("SELECT setting_value FROM admin_settings WHERE setting_key = 'base_investment'");
    return result.rows.length > 0 ? parseFloat(result.rows[0].setting_value) : 10000;
}

// ===== SEND COLLECTED ITEMS TO INVENTORY (FULL AI AUTO-PIPELINE) =====
router.post('/send-to-inventory', async (req, res) => {
    try {
        const pool = getDb();
        const { request_id } = req.body;

        if (!request_id) return res.status(400).json({ error: 'Request ID is required' });

        const itemsResult = await pool.query("SELECT * FROM collection_items WHERE request_id = $1", [request_id]);
        if (itemsResult.rows.length === 0) return res.status(400).json({ error: 'No collection items found for this request' });

        const reqResult = await pool.query(`SELECT pr.*, u.shop_name FROM pickup_requests pr JOIN users u ON pr.client_id = u.id WHERE pr.id = $1`, [request_id]);
        const shopName = reqResult.rows[0]?.shop_name || 'Unknown Shop';
        const driverId = reqResult.rows[0]?.driver_id;

        const existing = await pool.query("SELECT COUNT(*) as c FROM inventory WHERE request_id = $1", [request_id]);
        if (parseInt(existing.rows[0].c) > 0) return res.status(400).json({ error: 'This pickup has already been sent to inventory' });

        // STEP 1: AI SENSOR SCAN
        const rawItems = itemsResult.rows;
        const sensorScanResults = [];
        const insertedItems = [];

        for (const item of rawItems) {
            const usablePercent = Math.round(70 + Math.random() * 25);
            const usableKg = Math.round(item.quantity_kg * usablePercent / 100 * 10) / 10;
            const wasteKg = Math.round((item.quantity_kg - usableKg) * 10) / 10;
            const conditions = ['Overripe/Soft', 'Dried/Shriveled', 'Partially Decomposed', 'Bruised/Damaged', 'Mold Spots (surface)'];
            const condition = conditions[Math.floor(Math.random() * conditions.length)];

            const fruitItems = ['apple', 'orange', 'banana', 'mango', 'grape', 'papaya', 'guava', 'pineapple', 'watermelon', 'pomegranate', 'lemon', 'coconut', 'jackfruit', 'sapota'];
            const vegItems = ['tomato', 'potato', 'onion', 'carrot', 'cabbage', 'spinach', 'brinjal', 'cauliflower', 'beetroot', 'radish', 'beans', 'capsicum', 'cucumber', 'pumpkin', 'drumstick', 'ladies finger'];
            const spiceItems = ['turmeric', 'ginger', 'garlic', 'chili', 'coriander', 'curry leaves', 'mint'];
            const grainItems = ['sugarcane', 'wheat', 'rice', 'corn', 'millet'];
            const itemLower = item.item_name.toLowerCase();

            let category = 'Mixed Waste';
            if (fruitItems.some(f => itemLower.includes(f))) category = 'Expired Fruit';
            else if (vegItems.some(v => itemLower.includes(v))) category = 'Expired Vegetable';
            else if (spiceItems.some(s => itemLower.includes(s))) category = 'Dried Spice/Herb';
            else if (grainItems.some(g => itemLower.includes(g))) category = 'Stale Grain';

            sensorScanResults.push({ item_name: item.item_name, original_kg: item.quantity_kg, usable_kg: usableKg, waste_kg: wasteKg, usable_percent: usablePercent, condition, category, sensor_status: '✅ Scanned & Verified' });

            await pool.query(
                `INSERT INTO inventory (request_id, item_name, quantity_kg, source_driver_id, source_shop_name, sent_by_manager_id) VALUES ($1,$2,$3,$4,$5,$6)`,
                [request_id, item.item_name, usableKg, driverId, shopName, req.user.id]
            );
            insertedItems.push({ ...item, quantity_kg: usableKg });
        }

        // STEP 2: AUTO-SEGREGATION
        const segregation = {};
        sensorScanResults.forEach(scan => {
            if (!segregation[scan.category]) segregation[scan.category] = { items: [], total_kg: 0, count: 0 };
            segregation[scan.category].items.push(scan.item_name);
            segregation[scan.category].total_kg += scan.usable_kg;
            segregation[scan.category].count++;
        });

        // STEP 3: AI PRODUCT PREDICTION
        const baseInvestment = await getBaseInvestment(pool);
        const productionResults = [];
        const allExtraMaterials = {};

        const itemMap = {};
        insertedItems.forEach(item => {
            const key = item.item_name.toLowerCase().trim();
            if (!itemMap[key]) itemMap[key] = { name: item.item_name, total_kg: 0 };
            itemMap[key].total_kg += item.quantity_kg;
        });

        for (const [itemKey, itemData] of Object.entries(itemMap)) {
            const prediction = getAIPrediction(itemData.name);

            for (const prod of prediction.products) {
                const existingProd = await pool.query(
                    "SELECT id FROM production_orders WHERE predicted_product = $1 AND status != 'completed'", [prod.product]
                );
                if (existingProd.rows.length > 0) continue;

                const materialCost = Math.round(prod.cost_per_kg * itemData.total_kg);
                const estimatedSelling = Math.round(prod.sell_per_kg * itemData.total_kg * 0.6);
                const recipeJSON = JSON.stringify(prod.recipe);
                const estHours = prod.hours || 4;

                const wasteIngredients = [], extraMaterials = [];
                prod.recipe.forEach(r => {
                    const rLower = r.item.toLowerCase();
                    const isWasteItem = Object.keys(AI_KNOWLEDGE_BASE).some(k => rLower.includes(k)) || rLower.includes('waste') || rLower.includes('rotten') || rLower.includes('spoiled') || rLower.includes('stale') || rLower.includes('wilted') || rLower.includes('dried');
                    if (isWasteItem) { wasteIngredients.push(r); }
                    else { extraMaterials.push(r); if (!allExtraMaterials[r.item]) allExtraMaterials[r.item] = 0; allExtraMaterials[r.item] += r.kg; }
                });

                // STEP 5: AUTO-CREATE PRODUCTION ORDER
                await pool.query(
                    `INSERT INTO production_orders (item_name, total_kg, predicted_product, predicted_use, recipe, confidence, material_cost, estimated_selling_price, estimated_hours, started_at, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),'in_production',$10)`,
                    [itemData.name, itemData.total_kg, prod.product, prod.use, recipeJSON, prod.confidence, materialCost, estimatedSelling, estHours, req.user.id]
                );

                await pool.query(
                    "UPDATE inventory SET status = 'processing', updated_at = NOW() WHERE LOWER(TRIM(item_name)) = $1 AND request_id = $2",
                    [itemKey, request_id]
                );

                productionResults.push({
                    waste_item: itemData.name, waste_kg: itemData.total_kg, product: prod.product, use: prod.use,
                    confidence: prod.confidence, material_cost: materialCost, estimated_selling: estimatedSelling,
                    estimated_hours: estHours, waste_ingredients: wasteIngredients, extra_materials_needed: extraMaterials,
                    status: '🏭 Auto-sent to Production'
                });
            }
        }

        // FREE THE DRIVER
        if (driverId) {
            await pool.query("UPDATE users SET is_free = 1 WHERE id = $1", [driverId]);
            await pool.query("INSERT INTO notifications (user_id, message, type, request_id) VALUES ($1,$2,$3,$4)",
                [driverId, `✅ Manager approved your collection for Pickup #${request_id}. Items sent to inventory. You are now FREE for new pickups!`, 'driver_freed', request_id]);
            const io = req.app.get('io');
            if (io) io.to(`user_${driverId}`).emit('driver_freed', { requestId: request_id, message: 'Your collection has been approved! You are now free for new pickups.' });
        }

        const extraMaterialsSummary = Object.entries(allExtraMaterials).map(([name, kg]) => ({ material: name, quantity_kg: Math.round(kg * 10) / 10, note: '⚠️ Must be procured separately' }));

        res.json({
            message: `✅ Full AI Pipeline Complete! ${sensorScanResults.length} items scanned → ${productionResults.length} products auto-sent to Production`,
            pipeline: {
                step1_sensor_scan: { description: '🔬 AI Sensor Quality Check', items_scanned: sensorScanResults.length, results: sensorScanResults },
                step2_segregation: { description: '📊 Auto-Segregation', categories: segregation },
                step3_ai_prediction: { description: '🤖 AI Product Prediction', products_predicted: productionResults.length, products: productionResults },
                step4_extra_materials: { description: '🧪 Extra Materials Needed', total_extra_items: extraMaterialsSummary.length, materials: extraMaterialsSummary },
                step5_production: { description: '🏭 Auto-Sent to Production', orders_created: productionResults.length, driver_freed: !!driverId }
            }
        });
    } catch (err) {
        console.error('Send to inventory error:', err);
        res.status(500).json({ error: 'Failed to send to inventory' });
    }
});

// ===== THRESHOLD-BASED AUTO PRODUCTION =====
const PRODUCTION_THRESHOLD_KG = 100;

async function checkThresholdProduction(io) {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT LOWER(TRIM(item_name)) as item_key, item_name, SUM(quantity_kg) as total_kg, COUNT(*) as batch_count
            FROM inventory WHERE status IN ('processing', 'processed')
            GROUP BY LOWER(TRIM(item_name)), item_name
            HAVING SUM(quantity_kg) >= ${PRODUCTION_THRESHOLD_KG}
        `);

        if (result.rows.length === 0) return;

        for (const item of result.rows) {
            const recent = await pool.query(
                "SELECT id FROM production_orders WHERE LOWER(TRIM(item_name)) = $1 AND status IN ('pending','in_production') AND created_at > NOW() - INTERVAL '1 hour'",
                [item.item_key]
            );
            if (recent.rows.length > 0) continue;

            const prediction = getItemPrediction(item.item_name);
            await pool.query(
                `INSERT INTO production_orders (item_name, total_kg, predicted_product, predicted_use, recipe, material_cost, estimated_selling_price, estimated_hours, started_at, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),'pending',1)`,
                [item.item_name, item.total_kg, prediction.product, prediction.use, JSON.stringify(prediction.recipe || []), prediction.cost || 0, prediction.sell || 0, prediction.hours || 4]
            );
            await pool.query(
                "UPDATE inventory SET status = 'consumed', updated_at = NOW() WHERE LOWER(TRIM(item_name)) = $1 AND status IN ('processing', 'processed')",
                [item.item_key]
            );
            console.log(`[AUTO-THRESHOLD] ${item.item_name} reached ${item.total_kg}kg → Auto-production: ${prediction.product}`);
            if (io) io.emit('threshold_production', { item_name: item.item_name, total_kg: item.total_kg, product: prediction.product });
        }
    } catch (err) {
        console.error('Threshold check error:', err);
    }
}

function getItemPrediction(itemName) {
    const key = itemName.toLowerCase().trim();
    const predMap = {
        'apple': { product: 'Apple Cider Vinegar', use: 'Food preservative and health drink', sell: 200, cost: 40, hours: 8 },
        'banana': { product: 'Banana Fiber Textile', use: 'Eco-friendly fabric and rope making', sell: 350, cost: 60, hours: 6 },
        'orange': { product: 'D-Limonene Cleaner', use: 'Industrial solvent and eco-cleaning', sell: 280, cost: 50, hours: 5 },
        'coconut': { product: 'Coco Coir Pots', use: 'Biodegradable planting pots', sell: 150, cost: 30, hours: 4 },
        'tomato': { product: 'Lycopene Extract', use: 'Natural red food coloring and supplement', sell: 400, cost: 70, hours: 10 },
        'potato': { product: 'Bio-Starch Plastic', use: 'Biodegradable packaging material', sell: 250, cost: 45, hours: 7 },
        'mango': { product: 'Mango Pectin Gel', use: 'Natural food thickener and jam base', sell: 300, cost: 55, hours: 6 },
        'onion': { product: 'Onion Dye Extract', use: 'Natural textile dye', sell: 180, cost: 35, hours: 5 },
        'sugarcane': { product: 'Bagasse Paper Pulp', use: 'Eco-friendly paper and packaging', sell: 200, cost: 40, hours: 8 },
        'turmeric': { product: 'Curcumin Supplement', use: 'Health supplement capsules', sell: 500, cost: 80, hours: 12 },
        'spinach': { product: 'Chlorophyll Green Dye', use: 'Natural food and textile coloring', sell: 350, cost: 60, hours: 6 },
        'carrot': { product: 'Beta-Carotene Extract', use: 'Natural orange food coloring', sell: 380, cost: 65, hours: 8 },
        'lemon': { product: 'Citric Acid Concentrate', use: 'Industrial cleaning and food acid', sell: 220, cost: 40, hours: 5 },
        'chili': { product: 'Capsaicin Extract', use: 'Pain relief cream ingredient', sell: 450, cost: 75, hours: 10 },
        'rice': { product: 'Rice Bran Oil', use: 'Cooking oil and cosmetics base', sell: 200, cost: 40, hours: 6 },
        'wheat': { product: 'Wheat Gluten Feed', use: 'High-protein animal feed', sell: 150, cost: 30, hours: 4 },
        'pineapple': { product: 'Bromelain Enzyme', use: 'Meat tenderizer and anti-inflammatory', sell: 500, cost: 90, hours: 12 },
        'guava': { product: 'Guava Leaf Tea', use: 'Herbal health tea', sell: 250, cost: 45, hours: 4 },
    };
    for (const [k, v] of Object.entries(predMap)) {
        if (key.includes(k)) return { product: v.product, use: v.use, sell: v.sell, cost: v.cost, hours: v.hours, recipe: [] };
    }
    return { product: `${itemName} Bio-Product`, use: 'Converted waste product', sell: 150, cost: 30, hours: 4, recipe: [] };
}

// ===== COMBINED AI PREDICTIONS =====
router.get('/predict/combined', async (req, res) => {
    try {
        const pool = getDb();
        const aggResult = await pool.query(`
            SELECT LOWER(TRIM(item_name)) as item_key, item_name, SUM(quantity_kg) as total_kg, COUNT(*) as source_count, STRING_AGG(DISTINCT source_shop_name, ',') as shops
            FROM inventory WHERE status IN ('processing', 'processed')
            GROUP BY LOWER(TRIM(item_name)), item_name ORDER BY SUM(quantity_kg) DESC
        `);
        if (aggResult.rows.length === 0) return res.json({ combined_predictions: [], available_items: [] });

        const items = aggResult.rows;
        const itemNames = items.map(i => i.item_name);
        const combined = getCombinedPredictions(itemNames);

        res.json({ available_items: items, combined_predictions: combined, total_combinations: combined.length, note: 'AI analyzed all inventory items and found these products by combining 2+ waste items' });
    } catch (err) {
        console.error('Combined prediction error:', err);
        res.status(500).json({ error: 'Failed to get combined predictions' });
    }
});

// ===== AI PREDICT ENDPOINT =====
router.get('/predict/:itemName', async (req, res) => {
    try {
        const pool = getDb();
        const prediction = getAIPrediction(req.params.itemName);
        const baseInvestment = await getBaseInvestment(pool);

        const products = prediction.products.map(p => {
            const wasteIngredients = [], extraMaterials = [];
            let extraCost = 0;
            p.recipe.forEach(r => {
                const rLower = r.item.toLowerCase();
                const isWaste = Object.keys(AI_KNOWLEDGE_BASE).some(k => rLower.includes(k)) || rLower.includes('waste') || rLower.includes('rotten') || rLower.includes('spoiled') || rLower.includes('stale') || rLower.includes('wilted') || rLower.includes('dried');
                if (isWaste) { wasteIngredients.push({ ...r, cost: 0, source: '♻️ From collected waste (free)' }); }
                else { const itemCost = Math.round(r.kg * (p.cost_per_kg * 0.3)); extraCost += itemCost; extraMaterials.push({ ...r, cost: itemCost, source: '🛒 Must be purchased separately' }); }
            });
            return {
                product: p.product, use: p.use, confidence: p.confidence, hours: p.hours,
                waste_ingredients: wasteIngredients, extra_materials: extraMaterials, extra_materials_cost: extraCost,
                total_cost_per_kg: p.cost_per_kg, selling_price_per_kg: p.sell_per_kg,
                profit_per_kg: p.sell_per_kg - p.cost_per_kg,
                profit_margin: Math.round((p.sell_per_kg - p.cost_per_kg) / p.sell_per_kg * 100) + '%',
                ai_model: 'GreenCycle AI v3.0 (Waste-Focused)'
            };
        });

        res.json({ item: req.params.itemName, source: '🤖 AI Prediction', predictions: products, base_investment: baseInvestment });
    } catch (err) {
        console.error('Prediction error:', err);
        res.status(500).json({ error: 'AI prediction failed' });
    }
});

// ===== HUMAN vs AI PREDICTION COMPARISON =====
router.post('/predict/compare', async (req, res) => {
    try {
        const pool = getDb();
        const { item_name, quantity_kg, human_suggestion } = req.body;

        if (!item_name || !quantity_kg) return res.status(400).json({ error: 'item_name and quantity_kg are required' });
        if (!human_suggestion || !human_suggestion.product) return res.status(400).json({ error: 'human_suggestion with product name is required' });

        const validation = validateProductName(human_suggestion.product, item_name);
        if (!validation.valid) return res.status(400).json({ error: validation.error });

        const qty = parseFloat(quantity_kg);
        const humanRecipe = human_suggestion.recipe || [];
        const aiEstimate = aiEstimateForHuman(humanRecipe, item_name);
        const hCost = parseFloat(human_suggestion.cost_per_kg) || aiEstimate.cost_per_kg;
        const hSell = parseFloat(human_suggestion.sell_per_kg) || aiEstimate.sell_per_kg;
        const hHours = parseFloat(human_suggestion.estimated_hours) || aiEstimate.hours;

        const aiPrediction = getAIPrediction(item_name);
        const aiProducts = aiPrediction.products.map(p => {
            const wasteIngredients = [], extraMaterials = [];
            let extraCost = 0;
            p.recipe.forEach(r => {
                const rLower = r.item.toLowerCase();
                const isWaste = RAW_WASTE_NAMES.some(w => rLower.includes(w)) || rLower.includes('waste') || rLower.includes('rotten') || rLower.includes('spoiled') || rLower.includes('stale') || rLower.includes('wilted') || rLower.includes('dried');
                if (isWaste) { wasteIngredients.push({ ...r, cost: 0, source: 'From waste' }); }
                else { const c = Math.round(r.kg * (p.cost_per_kg * 0.3)); extraCost += c; extraMaterials.push({ ...r, cost: c, source: 'Purchase' }); }
            });
            const totalCost = Math.round(p.cost_per_kg * qty);
            const totalRevenue = Math.round(p.sell_per_kg * qty * 0.6);
            return { product: p.product, use: p.use, confidence: p.confidence, hours: p.hours, waste_ingredients: wasteIngredients, extra_materials: extraMaterials, extra_materials_cost: extraCost, total_material_cost: totalCost, estimated_revenue: totalRevenue, profit: totalRevenue - totalCost, profit_margin: (totalRevenue > 0 ? Math.round((totalRevenue - totalCost) / totalRevenue * 100) : 0) + '%', score: 0 };
        });

        const humanWasteIng = [], humanExtraMat = [];
        let humanExtraCost = 0;
        humanRecipe.forEach(r => {
            const rLower = r.item.toLowerCase();
            const isWaste = RAW_WASTE_NAMES.some(w => rLower.includes(w)) || rLower.includes('waste') || rLower.includes('rotten') || rLower.includes('spoiled') || rLower.includes('stale') || rLower.includes('wilted') || rLower.includes('dried');
            if (isWaste) { humanWasteIng.push({ ...r, cost: 0, source: 'From waste' }); }
            else { const c = Math.round(r.kg * (hCost * 0.3)); humanExtraCost += c; humanExtraMat.push({ ...r, cost: c, source: 'Purchase' }); }
        });

        const humanTotalCost = Math.round(hCost * qty);
        const humanRevenue = Math.round(hSell * qty * 0.6);
        const humanProfit = humanRevenue - humanTotalCost;
        const humanResult = {
            product: human_suggestion.product, use: human_suggestion.use || 'Researcher-defined product',
            confidence: 'researcher', hours: hHours,
            waste_ingredients: humanWasteIng, extra_materials: humanExtraMat,
            extra_materials_cost: humanExtraCost, total_material_cost: humanTotalCost,
            estimated_revenue: humanRevenue, profit: humanProfit,
            profit_margin: (humanRevenue > 0 ? Math.round(humanProfit / humanRevenue * 100) : 0) + '%',
            ai_estimated: { cost_per_kg: hCost, sell_per_kg: hSell, hours: hHours, note: 'AI auto-estimated based on ingredient complexity' },
            score: 0
        };

        function calcScore(p) {
            const profitS = Math.max(0, Math.min(100, (p.profit / Math.max(p.total_material_cost, 1)) * 30));
            const costS = Math.max(0, 100 - p.extra_materials_cost * 0.5);
            const timeS = Math.max(0, 100 - p.hours * 5);
            const ingredS = Math.max(0, 100 - p.extra_materials.length * 15);
            return Math.round(profitS * 0.4 + costS * 0.25 + timeS * 0.15 + ingredS * 0.2);
        }

        const bestAI = aiProducts.reduce((best, p) => {
            p.score = calcScore(p);
            return p.score > (best?.score || 0) ? p : best;
        }, aiProducts[0] ? { ...aiProducts[0], score: calcScore(aiProducts[0]) } : null);

        humanResult.score = calcScore(humanResult);
        const aiScore = bestAI ? bestAI.score : 0;
        const winner = humanResult.score > aiScore ? 'human' : (aiScore > humanResult.score ? 'ai' : 'tie');
        const winnerProd = winner === 'human' ? humanResult : (bestAI || humanResult);

        const response = {
            ai_prediction: { source: 'AI GreenCycle v3.0', products: aiProducts, best_product: bestAI, best_score: aiScore },
            human_prediction: { source: 'Human Researcher', suggestion: humanResult, score: humanResult.score },
            comparison_result: {
                winner: winner === 'human' ? 'Human Researcher Wins!' : (winner === 'ai' ? 'AI Prediction Wins!' : 'Tie!'),
                ai_score: aiScore, human_score: humanResult.score,
                winning_product: winnerProd.product,
                recommendation: winner === 'human' ? `Human researcher's "${humanResult.product}" is more cost-effective.` : `AI's "${bestAI?.product}" offers better returns.`,
                scoring_criteria: { profit_weight: '40%', cost_efficiency: '25%', production_speed: '15%', fewer_extra_materials: '20%' }
            }
        };

        if (req.body.auto_produce) {
            const recipe = winner === 'human' ? humanRecipe : (bestAI ? bestAI.waste_ingredients.concat(bestAI.extra_materials) : []);
            await pool.query(
                `INSERT INTO production_orders (item_name, total_kg, predicted_product, predicted_use, recipe, confidence, material_cost, estimated_selling_price, estimated_hours, started_at, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),'in_production',$10)`,
                [item_name, qty, winnerProd.product, winnerProd.use, JSON.stringify(recipe.map(r => ({ item: r.item, kg: r.kg }))), winnerProd.confidence, winnerProd.total_material_cost, winnerProd.estimated_revenue, winnerProd.hours, req.user.id]
            );
            response.production_order = {
                status: 'Production order created!', approach: winner === 'human' ? 'Human' : 'AI',
                product: winnerProd.product, extra_materials_to_buy: winner === 'human' ? humanExtraMat : (bestAI?.extra_materials || []),
                total_extra_cost: winner === 'human' ? humanExtraCost : (bestAI?.extra_materials_cost || 0)
            };
        }

        res.json(response);
    } catch (err) {
        console.error('Comparison error:', err);
        res.status(500).json({ error: 'Failed to compare predictions' });
    }
});

// ===== AGGREGATED INVENTORY =====
router.get('/aggregated', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT LOWER(TRIM(item_name)) as item_key, item_name, SUM(quantity_kg) as total_kg, COUNT(*) as source_count, STRING_AGG(DISTINCT source_shop_name, ',') as shops
            FROM inventory WHERE status IN ('processing', 'processed')
            GROUP BY LOWER(TRIM(item_name)), item_name ORDER BY SUM(quantity_kg) DESC
        `);

        const aggregated = result.rows.map(obj => {
            obj.threshold_kg = PRODUCTION_THRESHOLD_KG;
            obj.threshold_pct = Math.min(100, Math.round((parseFloat(obj.total_kg) / PRODUCTION_THRESHOLD_KG) * 100));
            obj.ready = parseFloat(obj.total_kg) >= PRODUCTION_THRESHOLD_KG;
            return obj;
        });

        res.json({ aggregated, threshold_kg: PRODUCTION_THRESHOLD_KG });
    } catch (err) {
        console.error('Aggregation error:', err);
        res.status(500).json({ error: 'Failed to aggregate inventory' });
    }
});

// ===== SEND TO PRODUCTION (manual) =====
router.post('/send-to-production', async (req, res) => {
    try {
        const pool = getDb();
        const { item_name, total_kg, predicted_product, predicted_use, recipe, material_cost, estimated_selling_price, estimated_hours, extra_cost } = req.body;
        if (!item_name) return res.status(400).json({ error: 'Item name is required' });

        const extraMaterialCost = parseFloat(extra_cost) || parseFloat(material_cost) || 0;
        let investmentBefore = 0, investmentAfter = 0;
        if (extraMaterialCost > 0) {
            const invResult = await pool.query("SELECT setting_value FROM admin_settings WHERE setting_key = 'base_investment'");
            investmentBefore = invResult.rows.length > 0 ? parseFloat(invResult.rows[0].setting_value) : 10000;
            investmentAfter = investmentBefore - extraMaterialCost;
            await pool.query("UPDATE admin_settings SET setting_value = $1 WHERE setting_key = 'base_investment'", [investmentAfter.toString()]);
        }

        await pool.query(
            `INSERT INTO production_orders (item_name, total_kg, predicted_product, predicted_use, recipe, material_cost, estimated_selling_price, estimated_hours, started_at, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),'in_production',$9)`,
            [item_name, total_kg || 0, predicted_product || '', predicted_use || '', recipe || '[]', extraMaterialCost, estimated_selling_price || 0, estimated_hours || 4, req.user.id]
        );

        if (item_name.includes('+')) {
            const parts = item_name.split('+');
            for (const part of parts) {
                await pool.query(
                    "UPDATE inventory SET status = 'consumed', updated_at = NOW() WHERE LOWER(TRIM(item_name)) LIKE '%' || $1 || '%' AND status IN ('processing', 'processed')",
                    [part.trim().toLowerCase()]
                );
            }
        } else {
            await pool.query(
                "UPDATE inventory SET status = 'consumed', updated_at = NOW() WHERE LOWER(TRIM(item_name)) = $1 AND status IN ('processing', 'processed')",
                [item_name.toLowerCase().trim()]
            );
        }

        const costMsg = extraMaterialCost > 0 ? ` Extra cost ₹${extraMaterialCost} deducted (₹${investmentBefore} → ₹${investmentAfter})` : '';
        res.json({ message: `${predicted_product || item_name} sent to production!${costMsg}`, investment_deducted: extraMaterialCost, investment_before: investmentBefore, investment_after: investmentAfter });
    } catch (err) {
        console.error('Send to production error:', err.message);
        res.status(500).json({ error: 'Failed to send to production' });
    }
});

// ===== PRODUCTION ORDERS LIST =====
router.get('/production', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`SELECT po.*, u.name as created_by_name FROM production_orders po LEFT JOIN users u ON po.created_by = u.id ORDER BY po.created_at DESC`);
        res.json({ orders: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch production orders' }); }
});

// ===== UPDATE PRODUCTION ORDER STATUS =====
router.put('/production/:id/status', async (req, res) => {
    try {
        const pool = getDb();
        const { status } = req.body;
        const validStatuses = ['pending', 'in_production', 'completed'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

        if (status === 'in_production') {
            await pool.query("UPDATE production_orders SET status = 'in_production', started_at = NOW(), updated_at = NOW() WHERE id = $1", [req.params.id]);
        } else {
            await pool.query("UPDATE production_orders SET status = $1, updated_at = NOW() WHERE id = $2", [status, req.params.id]);
        }

        if (status === 'completed') {
            const order = await pool.query("SELECT * FROM production_orders WHERE id = $1", [req.params.id]);
            if (order.rows.length > 0) {
                const o = order.rows[0];
                await pool.query("INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item) VALUES ($1,$2,$3,$4)",
                    [o.id, o.predicted_product, o.total_kg * 0.6, o.item_name]);
                await pool.query("UPDATE inventory SET status = 'processed', updated_at = NOW() WHERE LOWER(TRIM(item_name)) = $1",
                    [o.item_name.toLowerCase().trim()]);
            }
        }

        res.json({ message: `Production status updated to ${status}` });
    } catch (err) { res.status(500).json({ error: 'Failed to update production status' }); }
});

// ===== PACKING ORDERS LIST =====
router.get('/packing', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, prod.item_name as source_raw_item, prod.predicted_product, prod.material_cost, prod.estimated_selling_price
            FROM packing_orders po JOIN production_orders prod ON po.production_order_id = prod.id ORDER BY po.created_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch packing orders' }); }
});

// ===== UPDATE PACKING ORDER STATUS =====
router.put('/packing/:id/status', async (req, res) => {
    try {
        const pool = getDb();
        const { status } = req.body;
        const validStatuses = ['pending', 'packing', 'packed', 'dispatched'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

        await pool.query("UPDATE packing_orders SET status = $1, updated_at = NOW() WHERE id = $2", [status, req.params.id]);

        if (status === 'packed') {
            const order = await pool.query("SELECT * FROM packing_orders WHERE id = $1", [req.params.id]);
            if (order.rows.length > 0) {
                const o = order.rows[0];
                const exists = await pool.query("SELECT COUNT(*) as c FROM warehouse_stocks WHERE packing_order_id = $1", [o.id]);
                if (parseInt(exists.rows[0].c) === 0) {
                    const batchNo = `BATCH-${String(o.id).padStart(3, '0')}`;
                    await pool.query("INSERT INTO warehouse_stocks (packing_order_id, product_name, quantity_kg, category, batch_no, location, status) VALUES ($1,$2,$3,'Waste Product',$4,'Main Warehouse','in_stock')",
                        [o.id, o.product_name, o.quantity_kg, batchNo]);
                }
            }
        }

        res.json({ message: `Packing status updated to ${status}` });
    } catch (err) { res.status(500).json({ error: 'Failed to update packing status' }); }
});

// ===== WAREHOUSE: List all stock =====
router.get('/warehouse', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`SELECT ws.*, po.source_item FROM warehouse_stocks ws LEFT JOIN packing_orders po ON ws.packing_order_id = po.id ORDER BY ws.created_at DESC`);
        const stocks = result.rows;
        const segregated = {};
        stocks.forEach(s => {
            if (!segregated[s.product_name]) segregated[s.product_name] = { product_name: s.product_name, category: s.category, total_kg: 0, batches: 0, items: [] };
            segregated[s.product_name].total_kg += parseFloat(s.quantity_kg);
            segregated[s.product_name].batches++;
            segregated[s.product_name].items.push(s);
        });
        res.json({ stocks, segregated: Object.values(segregated) });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch warehouse stocks' }); }
});

// ===== WAREHOUSE: Send to warehouse manually =====
router.post('/warehouse/add', async (req, res) => {
    try {
        const pool = getDb();
        const { packing_order_id, product_name, quantity_kg, category, location } = req.body;
        if (!product_name || !quantity_kg) return res.status(400).json({ error: 'Product name and quantity are required' });
        const batchNo = `BATCH-${Date.now().toString(36).toUpperCase()}`;
        await pool.query("INSERT INTO warehouse_stocks (packing_order_id, product_name, quantity_kg, category, batch_no, location) VALUES ($1,$2,$3,$4,$5,$6)",
            [packing_order_id || null, product_name, quantity_kg, category || 'Waste Product', batchNo, location || 'Main Warehouse']);
        if (packing_order_id) await pool.query("UPDATE packing_orders SET status = 'dispatched', updated_at = NOW() WHERE id = $1", [packing_order_id]);
        res.json({ message: `${product_name} (${quantity_kg}kg) added to warehouse | Batch: ${batchNo}` });
    } catch (err) { res.status(500).json({ error: 'Failed to add to warehouse' }); }
});

// ===== WAREHOUSE: Update stock status =====
router.put('/warehouse/:id/status', async (req, res) => {
    try {
        const pool = getDb();
        const { status } = req.body;
        const validStatuses = ['in_stock', 'reserved', 'dispatching', 'sold'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
        await pool.query("UPDATE warehouse_stocks SET status = $1, updated_at = NOW() WHERE id = $2", [status, req.params.id]);
        res.json({ message: `Warehouse stock status updated to ${status}` });
    } catch (err) { res.status(500).json({ error: 'Failed to update warehouse status' }); }
});

// ===== SALES: Create customer order =====
router.post('/sales/create', async (req, res) => {
    try {
        const pool = getDb();
        const { warehouse_stock_id, product_name, quantity_kg, customer_name, customer_phone, customer_address, customer_zone, selling_price } = req.body;
        if (!product_name || !quantity_kg || !customer_name) return res.status(400).json({ error: 'Product, quantity, and customer name are required' });
        await pool.query("INSERT INTO customer_orders (warehouse_stock_id, product_name, quantity_kg, customer_name, customer_phone, customer_address, customer_zone, total_price, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'placed')",
            [warehouse_stock_id || null, product_name, quantity_kg, customer_name, customer_phone || '', customer_address || '', customer_zone || '', selling_price || 0]);
        if (warehouse_stock_id) await pool.query("UPDATE warehouse_stocks SET status = 'reserved', updated_at = NOW() WHERE id = $1", [warehouse_stock_id]);
        res.json({ message: `Order created: ${product_name} (${quantity_kg}kg) for ${customer_name}` });
    } catch (err) { res.status(500).json({ error: 'Failed to create order' }); }
});

// ===== SALES: List all customer orders =====
router.get('/sales', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT co.*, d.name as driver_name, d.phone as driver_phone, ws.batch_no, ws.location as warehouse_location
            FROM customer_orders co LEFT JOIN users d ON co.sales_driver_id = d.id LEFT JOIN warehouse_stocks ws ON co.warehouse_stock_id = ws.id ORDER BY co.created_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch customer orders' }); }
});

// ===== SALES: Update order status =====
router.put('/sales/:id/status', async (req, res) => {
    try {
        const pool = getDb();
        const { status } = req.body;
        const validStatuses = ['placed', 'confirmed', 'packing', 'shipped', 'at_zone_hub', 'out_for_delivery', 'delivered', 'cancelled'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

        await pool.query("UPDATE customer_orders SET status = $1, updated_at = NOW() WHERE id = $2", [status, req.params.id]);

        if (status === 'shipped' || status === 'delivered') {
            const order = await pool.query("SELECT warehouse_stock_id FROM customer_orders WHERE id = $1", [req.params.id]);
            if (order.rows.length > 0 && order.rows[0].warehouse_stock_id) {
                const wsStatus = status === 'shipped' ? 'dispatching' : 'sold';
                await pool.query("UPDATE warehouse_stocks SET status = $1, updated_at = NOW() WHERE id = $2", [wsStatus, order.rows[0].warehouse_stock_id]);
            }
        }

        res.json({ message: `Order status updated to ${status}` });
    } catch (err) { res.status(500).json({ error: 'Failed to update order status' }); }
});

module.exports = router;
module.exports.router = router;
module.exports.checkThresholdProduction = checkThresholdProduction;
module.exports.PRODUCTION_THRESHOLD_KG = PRODUCTION_THRESHOLD_KG;
