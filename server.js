// server.js - Updated Node.js backend with Firebase integration and authentication
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Session configuration
// Session configuration with longer expiration
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Set to true if using HTTPS
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days instead of 24 hours
        httpOnly: true // Security improvement
    }
}));

// Initialize Firebase Admin SDK with better error handling
let db = null;
let firebaseInitialized = false;

try {
    const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT;
    
    if (serviceAccountString && serviceAccountString.trim() !== '{}') {
        // Parse the service account JSON
        const serviceAccount = JSON.parse(serviceAccountString);
        
        // Validate required fields
        if (serviceAccount.type && serviceAccount.project_id && serviceAccount.private_key) {
            // Fix private key formatting if needed
            if (serviceAccount.private_key && !serviceAccount.private_key.includes('\\n')) {
                console.log('Private key format looks correct');
            }
            
            const admin = require('firebase-admin');
            
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.FIREBASE_DATABASE_URL
            });
            
            db = admin.firestore();
            firebaseInitialized = true;
            console.log('✅ Firebase Admin SDK initialized successfully');
        } else {
            console.warn('⚠️  Firebase service account missing required fields (type, project_id, private_key)');
        }
    } else {
        console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not configured in .env file');
    }
} catch (error) {
    console.error('❌ Error initializing Firebase:', error.message);
    console.log('🔧 Tips to fix this:');
    console.log('1. Make sure your .env file has FIREBASE_SERVICE_ACCOUNT with valid JSON');
    console.log('2. The private key should have \\n for line breaks (copy exactly from downloaded file)');
    console.log('3. Make sure the JSON is valid (use a JSON validator)');
    console.log('4. The app will continue without Firebase - pages will only be temporary');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    } else {
        return res.redirect('/login');
    }
}

// Store for temporary status pages (before saving to Firebase)
const tempStatusPages = new Map();

// Helper function to clean up expired pages (older than 30 days)
async function cleanupExpiredPages() {
    if (!db) {
        console.log('⏭️  Skipping cleanup - Firebase not initialized');
        return;
    }
    
    try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const expiredPages = await db.collection('statusPages')
            .where('createdAt', '<', thirtyDaysAgo.toISOString())
            .get();

        if (!expiredPages.empty) {
            const batch = db.batch();
            expiredPages.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log(`🗑️  Cleaned up ${expiredPages.size} expired status pages`);
        } else {
            console.log('✅ No expired pages to clean up');
        }
    } catch (error) {
        // Handle case where collection doesn't exist yet
        if (error.code === 5 || error.message.includes('NOT_FOUND')) {
            console.log('📝 No status pages collection yet - will be created when first page is saved');
        } else {
            console.error('❌ Error cleaning up expired pages:', error.message);
        }
    }
}

// Run cleanup on server start and every 24 hours (only if Firebase is working)
if (firebaseInitialized) {
    cleanupExpiredPages();
    setInterval(cleanupExpiredPages, 24 * 60 * 60 * 1000); // 24 hours
}

// Real US shipping facilities and routes
const shippingFacilities = {
    'CA': ['Los Angeles Distribution Center', 'San Francisco Bay Area Facility', 'Oakland Sorting Facility'],
    'NY': ['Queens Distribution Center', 'Brooklyn Sorting Facility', 'Long Island Facility'],
    'TX': ['Dallas-Fort Worth Hub', 'Houston Distribution Center', 'Austin Sorting Facility'],
    'FL': ['Miami Distribution Center', 'Orlando Sorting Facility', 'Tampa Bay Facility'],
    'IL': ['Chicago O\'Hare Hub', 'Rockford Distribution Center', 'Schaumburg Facility'],
    'OH': ['Cincinnati Hub', 'Columbus Distribution Center', 'Cleveland Sorting Facility'],
    'PA': ['Philadelphia Distribution Center', 'Pittsburgh Sorting Facility', 'Allentown Hub'],
    'GA': ['Atlanta Distribution Center', 'Savannah Sorting Facility', 'Augusta Hub'],
    'NC': ['Charlotte Hub', 'Raleigh Distribution Center', 'Greensboro Sorting Facility'],
    'WA': ['Seattle Distribution Center', 'Spokane Sorting Facility', 'Tacoma Hub'],
    'DEFAULT': ['Regional Distribution Center', 'Local Sorting Facility', 'Area Hub']
};

// Major transit hubs for cross-country shipping
const majorTransitHubs = [
    'Memphis, TN Hub', 'Louisville, KY World Hub', 'Indianapolis, IN Hub',
    'Cincinnati, OH Air Hub', 'Phoenix, AZ Distribution Center', 'Denver, CO Hub',
    'Dallas, TX Hub', 'Atlanta, GA Hub', 'Chicago, IL Hub', 'Los Angeles, CA Hub'
];

// Shopify configuration
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = '2024-01';

// Helper function to subtract business days (excluding weekends)
function subtractBusinessDays(date, days) {
    const result = new Date(date);
    let subtractedDays = 0;
    
    while (subtractedDays < days) {
        result.setDate(result.getDate() - 1);
        // Skip weekends (0 = Sunday, 6 = Saturday)
        if (result.getDay() !== 0 && result.getDay() !== 6) {
            subtractedDays++;
        }
    }
    
    return result;
}

// Helper function to add business days (excluding weekends)
function addBusinessDays(date, days) {
    const result = new Date(date);
    let addedDays = 0;
    
    while (addedDays < days) {
        result.setDate(result.getDate() + 1);
        // Skip weekends (0 = Sunday, 6 = Saturday)
        if (result.getDay() !== 0 && result.getDay() !== 6) {
            addedDays++;
        }
    }
    
    return result;
}

// Helper function to get random business days interval (3-5 days)
function getRandomBusinessDaysInterval() {
    return Math.floor(Math.random() * 3) + 3; // Random number between 3-5
}





// Helper function to fetch order from Shopify
async function fetchShopifyOrder(orderNumber) {
    try {
        // Clean order number - remove # if present and handle both formats
        const cleanOrderNumber = orderNumber.replace('#', '');
        
        // Try searching with # first, then without
        let searchUrl = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?name=%23${cleanOrderNumber}&status=any`;
        
        let response = await axios.get(searchUrl, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        // If not found with #, try without #
        if (!response.data.orders || response.data.orders.length === 0) {
            searchUrl = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?name=${cleanOrderNumber}&status=any`;
            
            response = await axios.get(searchUrl, {
                headers: {
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json'
                }
            });
        }

        if (response.data.orders && response.data.orders.length > 0) {
            const order = response.data.orders[0];
            
            // Check if any fulfillment is actually delivered
            let isDelivered = false;
            let deliveryDate = null;
            
            if (order.fulfillments && order.fulfillments.length > 0) {
                for (const fulfillment of order.fulfillments) {
                    if (fulfillment.status === 'success' && fulfillment.shipment_status === 'delivered') {
                        isDelivered = true;
                        deliveryDate = fulfillment.updated_at;
                        break;
                    }
                }
            }
            
            return {
                success: true,
                order: {
                    id: order.id,
                    orderNumber: order.name,
                    createdAt: order.created_at,
                    fulfillmentStatus: order.fulfillment_status,
                    financialStatus: order.financial_status,
                    isDelivered: isDelivered,
                    deliveryDate: deliveryDate,
                    shippingAddress: {
                        name: order.shipping_address?.name || '',
                        address1: order.shipping_address?.address1 || '',
                        address2: order.shipping_address?.address2 || '',
                        city: order.shipping_address?.city || '',
                        province: order.shipping_address?.province || '',
                        provinceCode: order.shipping_address?.province_code || '',
                        country: order.shipping_address?.country || '',
                        zip: order.shipping_address?.zip || ''
                    },
                    customer: {
                        firstName: order.customer?.first_name || '',
                        lastName: order.customer?.last_name || '',
                        email: order.customer?.email || ''
                    },
                    fulfillments: order.fulfillments || []
                }
            };
        } else {
            return {
                success: false,
                error: 'Order not found'
            };
        }
    } catch (error) {
        console.error('Shopify API Error:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.errors || 'Failed to fetch order from Shopify'
        };
    }
}


// Helper function to fetch order metafields (including replacement tracking)
async function fetchOrderMetafields(orderId) {
    try {
        const metafieldsUrl = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/metafields.json`;
        
        const response = await axios.get(metafieldsUrl, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });
        
        const metafields = response.data.metafields || [];
        const replacementTracking = metafields.find(m => 
            m.key === 'replacement_tracking' || 
            m.namespace === 'custom'
        );
        
        return {
            success: true,
            replacementTracking: replacementTracking || null
        };
    } catch (error) {
        console.error('Metafields fetch error:', error.message);
        return {
            success: false,
            replacementTracking: null
        };
    }
}

// Helper function to get main tracking number from order
function getMainTrackingNumber(order) {
    if (order.fulfillments && order.fulfillments.length > 0) {
        for (const fulfillment of order.fulfillments) {
            if (fulfillment.tracking_number) {
                return fulfillment.tracking_number;
            }
            if (fulfillment.tracking_numbers && fulfillment.tracking_numbers.length > 0) {
                return fulfillment.tracking_numbers[0];
            }
        }
    }
    return null;
}

// Updated function to handle fulfillment dates properly with Label Created 2 days before and optional custom pickup date
function generateRealisticTrackingEventsWithFulfillment(orderDate, destinationCity, provinceCode, isDelivered, deliveryDate, fulfillments, customPickupDate = null) {
    const events = [];
    const today = new Date();
    const orderDateObj = new Date(orderDate);
    
    // Get appropriate facilities for the destination state
    const stateFacilities = shippingFacilities[provinceCode] || shippingFacilities['DEFAULT'];
    const destinationFacility = stateFacilities[Math.floor(Math.random() * stateFacilities.length)];
    
    // REAL DATES FROM YOUR SHOPIFY DATA:
    // 1. Order Confirmed = Original order creation date 
    const orderConfirmedDate = new Date(orderDateObj);
    
    // 2. Label Created = 2 business days BEFORE the fulfillment date (or pickup date if custom)
    let labelCreatedDate = new Date(today); // Default to today
    
    // 3. Package Picked Up = Custom pickup date if provided, otherwise calculated
    let packagePickupDate = null;
    
// In the generateRealisticTrackingEventsWithFulfillment function, 
// replace the automatic date calculation section with this:

// Replace the existing date calculation logic with this:
if (customPickupDate) {
    // Use custom pickup date - this is the LABEL CREATED date for replacement tracking
    labelCreatedDate = new Date(customPickupDate);
    
    // Package Picked Up = 1-2 business days AFTER label created
    packagePickupDate = addBusinessDays(labelCreatedDate, Math.floor(Math.random() * 2) + 1);
    
    // Ensure label date is not before order date
    if (labelCreatedDate <= orderDateObj) {
        labelCreatedDate = addBusinessDays(orderDateObj, 1); // Day after order
        packagePickupDate = addBusinessDays(labelCreatedDate, 1);
    }
} else {
    // AUTOMATIC DATE LOGIC - ensure chronological order starting from order date
    
    // Label Created = 1-3 business days AFTER order date
    labelCreatedDate = addBusinessDays(orderDateObj, Math.floor(Math.random() * 3) + 1);
    
    // Package Picked Up = 1-2 business days AFTER label created
    packagePickupDate = addBusinessDays(labelCreatedDate, Math.floor(Math.random() * 2) + 1);
    
    // If we have fulfillment data, we can use it as a reference but still maintain logical order
    if (fulfillments && fulfillments.length > 0) {
        const shipmentFulfillment = fulfillments.find(f => f.tracking_number || f.tracking_numbers?.length > 0);
        if (shipmentFulfillment) {
            const fulfillmentDate = new Date(shipmentFulfillment.created_at);
            
            // If fulfillment date is reasonable (not too far from order), adjust our dates
            const daysBetweenOrderAndFulfillment = Math.floor((fulfillmentDate - orderDateObj) / (1000 * 60 * 60 * 24));
            
            if (daysBetweenOrderAndFulfillment > 0 && daysBetweenOrderAndFulfillment < 30) {
                // Use fulfillment as reference point, working backwards logically
                packagePickupDate = subtractBusinessDays(fulfillmentDate, 1); // Day before fulfillment
                labelCreatedDate = subtractBusinessDays(packagePickupDate, Math.floor(Math.random() * 2) + 1);
                
                // But never allow label date to be before or same as order date
                if (labelCreatedDate <= orderDateObj) {
                    labelCreatedDate = addBusinessDays(orderDateObj, 1);
                    packagePickupDate = addBusinessDays(labelCreatedDate, 1);
                }
            }
        }
    }
}
    
 // Event templates with corrected date logic
const eventTemplates = [
    { 
        status: 'Order Confirmed', 
        location: 'Order Processing Center', 
        fixedDate: orderConfirmedDate 
    },
    { 
        status: 'Order Processed', 
        location: 'Fulfillment Center', 
        fixedDate: addBusinessDays(orderConfirmedDate, Math.floor(Math.random() * 2) + 1) // 1-2 days after order
    },
    { 
        status: 'Label Created', 
        location: 'Origin Facility', 
        fixedDate: labelCreatedDate
    },
    { 
        status: 'Package Picked Up', 
        location: 'Local Pickup Facility', 
        fixedDate: packagePickupDate
    },
    { 
        status: 'Departed Origin Facility', 
        location: 'Origin Facility', 
        businessDaysFromPrevious: 1 // 1 day after pickup
    },
    { 
        status: 'In Transit', 
        location: null, 
        businessDaysFromPrevious: getRandomBusinessDaysInterval() 
    },
    { 
        status: 'Arrived at Sorting Facility', 
        location: null, 
        businessDaysFromPrevious: getRandomBusinessDaysInterval() 
    },
    { 
        status: 'Departed Sorting Facility', 
        location: null, 
        businessDaysFromPrevious: getRandomBusinessDaysInterval() 
    },
    { 
        status: 'Arrived at Destination Facility', 
        location: destinationFacility, 
        businessDaysFromPrevious: getRandomBusinessDaysInterval() 
    },
    { 
        status: 'Out for Delivery', 
        location: `${destinationCity}, ${provinceCode}`, 
        businessDaysFromPrevious: getRandomBusinessDaysInterval() 
    }
];
    
    // Calculate event dates
    let currentEventDate = orderDateObj;
    
    for (let i = 0; i < eventTemplates.length; i++) {
        const template = eventTemplates[i];
        
        // Use fixed date if specified, otherwise calculate from previous event
        if (template.fixedDate) {
            currentEventDate = new Date(template.fixedDate);
        } else if (i > 0) {
            // Calculate from previous event date using business days
            currentEventDate = addBusinessDays(currentEventDate, template.businessDaysFromPrevious);
        }
        
        // Skip events that are in the future
        if (currentEventDate > today) {
            break;
        }
        
        let location = template.location;
        
        // For transit events, pick random locations
        if (!location) {
            if (template.status.includes('Transit')) {
                location = majorTransitHubs[Math.floor(Math.random() * majorTransitHubs.length)];
            } else if (template.status.includes('Sorting')) {
                location = stateFacilities[Math.floor(Math.random() * stateFacilities.length)];
            }
        }
        
        events.push({
            status: template.status,
            date: currentEventDate.toLocaleDateString('en-US', { 
                weekday: 'short', 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
            }),
            time: generateRealisticTime(currentEventDate, template.status),
            location: location,
            completed: true, // All past events are completed
            current: false, // Will be set below for the last event
            isDelivered: false,
            isCustomPickup: template.status === 'Package Picked Up' && customPickupDate // Flag for custom pickup events
        });
    }
    
    // Mark the last event as current (if not delivered)
    if (events.length > 0 && !isDelivered) {
        events[events.length - 1].current = true;
        events[events.length - 1].completed = false; // Current event is not yet completed
    }
    
    // Add delivered event if actually delivered in Shopify
    if (isDelivered && deliveryDate) {
        const actualDeliveryDate = new Date(deliveryDate);
        events.push({
            status: 'Delivered',
            date: actualDeliveryDate.toLocaleDateString('en-US', { 
                weekday: 'short', 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
            }),
            time: generateRealisticTime(actualDeliveryDate, 'Delivered'),
            location: `${destinationCity}, ${provinceCode}`,
            completed: true,
            current: false,
            isDelivered: true
        });
    }
    
    return events;
}

// Helper function to detect carrier and generate tracking URL
function detectCarrierAndGenerateUrl(trackingNumber) {
    const carriers = {
        'UPS': {
            pattern: /^1Z[0-9A-Z]{16}$/,
            url: `https://www.ups.com/track?track=yes&trackNums=${trackingNumber}`,
            name: 'UPS'
        },
        'USPS': {
            pattern: /^(94|93|92|91|90|82|81|80|70|23|13|03|04)\d{18,20}$/,
            url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
            name: 'USPS'
        },
        'FedEx': {
            pattern: /^(\d{12}|\d{14}|\d{15}|\d{20}|\d{22})$/,
            url: `https://www.fedex.com/fedextrack/?tracknumber=${trackingNumber}`,
            name: 'FedEx'
        },
        'DHL': {
            pattern: /^(\d{10}|\d{11})$/,
            url: `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`,
            name: 'DHL'
        },
        'Amazon': {
            pattern: /^TBA\d{12}$/,
            url: `https://track.amazon.com/tracking/${trackingNumber}`,
            name: 'Amazon Logistics'
        }
    };

    for (const [carrierCode, carrier] of Object.entries(carriers)) {
        if (carrier.pattern.test(trackingNumber)) {
            return {
                carrier: carrier.name,
                trackingUrl: carrier.url,
                carrierCode: carrierCode
            };
        }
    }

    // Default carrier if pattern doesn't match
    return {
        carrier: 'Carrier',
        trackingUrl: `https://www.google.com/search?q=track+package+${trackingNumber}`,
        carrierCode: 'UNKNOWN'
    };
}

function generateRealisticTime(date, status) {
    let hour, minute, period;
    
    switch (status) {
        case 'Order Confirmed':
        case 'Order Processed':
            // Business hours
            hour = Math.floor(Math.random() * 8) + 9; // 9 AM - 5 PM
            break;
        case 'Package Picked Up':
        case 'Label Created':
            // Early morning pickup
            hour = Math.floor(Math.random() * 4) + 6; // 6 AM - 10 AM
            break;
        case 'Out for Delivery':
            // Morning delivery prep
            hour = Math.floor(Math.random() * 3) + 8; // 8 AM - 11 AM
            break;
        case 'Delivered':
            // Delivery hours
            hour = Math.floor(Math.random() * 8) + 10; // 10 AM - 6 PM
            break;
        default:
            // General transit times
            hour = Math.floor(Math.random() * 24);
    }
    
    minute = Math.floor(Math.random() * 60);
    
    if (hour > 12) {
        period = 'PM';
        hour = hour - 12;
    } else if (hour === 12) {
        period = 'PM';
    } else if (hour === 0) {
        hour = 12;
        period = 'AM';
    } else {
        period = 'AM';
    }
    
    return `${hour}:${String(minute).padStart(2, '0')} ${period}`;
}

// LOGIN ROUTES
app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) {
        return res.redirect('/');
    }
    
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login - Order Status Manager</title>
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .login-container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            padding: 40px;
            width: 100%;
            max-width: 400px;
        }
        .login-header {
            text-align: center;
            margin-bottom: 30px;
        }
        .login-header h1 {
            color: #1a1a1a;
            font-size: 24px;
            margin-bottom: 8px;
        }
        .login-header p {
            color: #666;
            font-size: 14px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
            color: #444;
        }
        input[type="text"], input[type="password"] {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e1e8ed;
            border-radius: 8px;
            font-size: 16px;
            transition: border-color 0.3s;
        }
        input[type="text"]:focus, input[type="password"]:focus {
            outline: none;
            border-color: #4CAF50;
        }
        .login-btn {
            width: 100%;
            padding: 12px 24px;
            background: #4CAF50;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s;
        }
        .login-btn:hover {
            background: #45a049;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3);
        }
        .error-message {
            background: #f8d7da;
            border: 1px solid #f5c6cb;
            color: #721c24;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 20px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="login-header">
            <h1>🔐 Admin Login</h1>
            <p>Order Status Manager</p>
        </div>
        
        ${req.query.error ? '<div class="error-message">Invalid username or password</div>' : ''}
        
        <form action="/login" method="POST">
    <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required>
    </div>
    
    <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required>
    </div>
    
    <div class="form-group" style="display: flex; align-items: center; gap: 8px; margin-bottom: 24px;">
        <input type="checkbox" id="rememberMe" name="rememberMe" style="width: auto;">
        <label for="rememberMe" style="margin: 0; font-weight: normal; color: #666;">Remember me for 30 days</label>
    </div>
    
    <button type="submit" class="login-btn">Login</button>
</form>
    </div>
</body>
</html>
    `);
});

app.post('/login', (req, res) => {
    const { username, password, rememberMe } = req.body;
    
    // Get credentials from environment variables
    const validUsername = process.env.ADMIN_USERNAME || 'admin';
    const validPassword = process.env.ADMIN_PASSWORD || 'password';
    
    if (username === validUsername && password === validPassword) {
        req.session.authenticated = true;
        
        // If remember me is checked, extend session to 30 days
        if (rememberMe) {
            req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        } else {
            req.session.cookie.maxAge = 24 * 60 * 60 * 1000; // 24 hours
        }
        
        res.redirect('/');
    } else {
        res.redirect('/login?error=1');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        res.redirect('/login');
    });
});

// PROTECTED ROUTES (require authentication)
// Check for tracking parameter and allow public access
app.get('/', (req, res) => {
    // If there's a track parameter, allow public access (customer tracking page)
    if (req.query.track) {
        return res.sendFile(__dirname + '/public/index.html');
    }
    
    // Otherwise, require authentication for admin panel
    return requireAuth(req, res, () => {
        res.sendFile(__dirname + '/public/index.html');
    });
});

// Admin dashboard route (alternative path)
app.get('/admin', requireAuth, (req, res) => {
    res.redirect('/');
});

// Favicon route
app.get('/favicon.ico', (req, res) => {
    res.sendFile(__dirname + '/public/favicon.ico');
});

// Helper function to validate pickup date (add this before the API endpoints)
function validatePickupDate(pickupDate, orderCreatedAt) {
    if (!pickupDate) {
        return { isValid: true }; // No pickup date provided is fine
    }
    
    const pickupDateObj = new Date(pickupDate);
    const orderDateObj = new Date(orderCreatedAt);
    
    // Remove time component for date comparison
    pickupDateObj.setHours(0, 0, 0, 0);
    orderDateObj.setHours(0, 0, 0, 0);
    
    // Check if pickup date is before order date
    if (pickupDateObj < orderDateObj) {
        return {
            isValid: false,
            error: `Pickup date (${pickupDateObj.toLocaleDateString()}) cannot be before the order creation date (${orderDateObj.toLocaleDateString()}). Packages cannot be picked up before they are ordered.`
        };
    }
    
    // Check if pickup date is too far in the future (more than 1 year from now)
    const oneYearFromNow = new Date();
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
    oneYearFromNow.setHours(0, 0, 0, 0);
    
    if (pickupDateObj > oneYearFromNow) {
        return {
            isValid: false,
            error: 'Pickup date cannot be more than 1 year in the future.'
        };
    }
    
    // Check if pickup date is too far in the past (more than 2 years ago)
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    twoYearsAgo.setHours(0, 0, 0, 0);
    
    if (pickupDateObj < twoYearsAgo) {
        return {
            isValid: false,
            error: 'Pickup date cannot be more than 2 years in the past.'
        };
    }
    
    return { isValid: true };
}

// API endpoints (protected)
app.post('/api/create-status-page', requireAuth, async (req, res) => {
    const { orderNumber, trackingNumber, pickupDate } = req.body;

    if (!orderNumber || !trackingNumber) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing required fields: orderNumber and trackingNumber' 
        });
    }

    try {
        // Fetch order from Shopify
        const shopifyResult = await fetchShopifyOrder(orderNumber);
        
        if (!shopifyResult.success) {
            return res.status(404).json(shopifyResult);
        }

        const { order } = shopifyResult;
        
        // Fetch metafields to check for replacement tracking
        const metafieldsResult = await fetchOrderMetafields(order.id);
        const replacementTrackingMetafield = metafieldsResult.replacementTracking;
        
        // Get the main tracking number from fulfillments
        const mainTrackingNumber = getMainTrackingNumber(order);
        
        // Check if the provided tracking number matches either main or replacement
        let isReplacementTracking = false;
        let labelCreatedDate = null;
        
        if (replacementTrackingMetafield && trackingNumber === replacementTrackingMetafield.value) {
            // This is a replacement tracking number
            isReplacementTracking = true;
            labelCreatedDate = replacementTrackingMetafield.updated_at; // CHANGED: Use updated_at instead of created_at
            console.log(`✅ Replacement tracking detected: ${trackingNumber}`);
            console.log(`📅 Label will be created on: ${labelCreatedDate}`);
        } else if (mainTrackingNumber && trackingNumber === mainTrackingNumber) {
            // This is the main tracking number
            isReplacementTracking = false;
            console.log(`✅ Main tracking number matched: ${trackingNumber}`);
        } else {
            // Tracking number doesn't match either
            return res.status(400).json({
                success: false,
                error: `Tracking number "${trackingNumber}" does not match the order. Please verify the tracking number and try again.`
            });
        }
        
        // For replacement tracking, use the metafield created_at as the custom pickup date
        let effectivePickupDate = pickupDate;
        if (isReplacementTracking && labelCreatedDate) {
            effectivePickupDate = labelCreatedDate;
        }
        
        // VALIDATE PICKUP DATE AGAINST ORDER DATE
        const pickupValidation = validatePickupDate(effectivePickupDate, order.createdAt);
        if (!pickupValidation.isValid) {
            return res.status(400).json({
                success: false,
                error: pickupValidation.error
            });
        }
        
        // Detect carrier and generate tracking URL
        const carrierInfo = detectCarrierAndGenerateUrl(trackingNumber);
        
        // Generate realistic tracking events with fulfillment data and optional pickup date
        const trackingEvents = generateRealisticTrackingEventsWithFulfillment(
            order.createdAt,
            order.shippingAddress.city,
            order.shippingAddress.provinceCode,
            order.isDelivered,
            order.deliveryDate,
            order.fulfillments,
            effectivePickupDate // Use replacement tracking date if applicable
        );

        // Create status page data
        const statusPageData = {
            customerName: `${order.customer.firstName} ${order.customer.lastName}`.trim(),
            orderNumber: order.orderNumber,
            trackingNumber: trackingNumber,
            carrier: carrierInfo.carrier,
            carrierCode: carrierInfo.carrierCode,
            trackingUrl: carrierInfo.trackingUrl,
            destination: `${order.shippingAddress.city}, ${order.shippingAddress.provinceCode} ${order.shippingAddress.zip}`,
            shippingAddress: order.shippingAddress,
            fulfillmentStatus: order.fulfillmentStatus,
            isDelivered: order.isDelivered,
            deliveryDate: order.deliveryDate,
            events: trackingEvents,
            customPickupDate: effectivePickupDate,
            isReplacementTracking: isReplacementTracking, // Flag to indicate this is a replacement
            replacementTrackingAddedDate: isReplacementTracking ? labelCreatedDate : null,
            createdAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            saved: false
        };

        // Generate unique page ID
        const pageId = crypto.randomBytes(8).toString('hex');
        
        // Store status page temporarily
        tempStatusPages.set(pageId, statusPageData);

        // Auto-cleanup temp pages after 1 hour if not saved
        setTimeout(() => {
            if (tempStatusPages.has(pageId) && !tempStatusPages.get(pageId).saved) {
                tempStatusPages.delete(pageId);
                console.log(`🗑️ Cleaned up unsaved temp page: ${pageId}`);
            }
        }, 60 * 60 * 1000);

        // Return success with page ID
        res.json({
            success: true,
            pageId: pageId,
            url: `${req.protocol}://${req.get('host')}/track/${pageId}`,
            data: statusPageData,
            isReplacement: isReplacementTracking
        });

    } catch (error) {
        console.error('Error creating status page:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});
// Other protected API endpoints
app.post('/api/save-status-page/:pageId', requireAuth, async (req, res) => {
    const { pageId } = req.params;
    
    try {
        // Get temp status data
        let statusData = tempStatusPages.get(pageId);
        
        if (!statusData) {
            return res.status(404).json({
                success: false,
                error: 'Status page not found or already expired'
            });
        }

        if (db) {
            try {
                // Save to Firebase
                await db.collection('statusPages').doc(pageId).set({
                    ...statusData,
                    saved: true,
                    savedAt: new Date().toISOString()
                });

                console.log(`💾 Status page saved to Firebase: ${pageId}`);
            } catch (error) {
                console.error('Error saving to Firebase:', error.message);
                // Continue anyway - mark as saved in temp storage
            }
        } else {
            console.log(`⚠️  Firebase not available - page ${pageId} remains temporary`);
        }

        // Update temp storage to mark as saved
        statusData.saved = true;
        tempStatusPages.set(pageId, statusData);

        res.json({
            success: true,
            message: db ? 'Status page saved to Firebase successfully' : 'Status page marked as saved (Firebase unavailable)'
        });

    } catch (error) {
        console.error('Error in save endpoint:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to save status page'
        });
    }
});

app.get('/api/health', requireAuth, (req, res) => {
    res.json({ 
        status: 'ok', 
        shopifyConnected: !!SHOPIFY_SHOP_DOMAIN && !!SHOPIFY_ACCESS_TOKEN,
        firebaseConnected: firebaseInitialized && !!db,
        authenticated: true
    });
});

// PUBLIC ROUTES (no authentication required)
// Tracking page route - accessible to customers
app.get('/api/status/:pageId', async (req, res) => {
    const { pageId } = req.params;
    
    let statusData = null;
    
    try {
        // First, try to get from Firebase (if available)
        if (db) {
            try {
                const doc = await db.collection('statusPages').doc(pageId).get();
                
                if (doc.exists) {
                    statusData = doc.data();
                }
            } catch (error) {
                // Handle case where collection doesn't exist yet
                if (error.code === 5 || error.message.includes('NOT_FOUND')) {
                    console.log('📝 Status page collection not found - checking temp storage');
                } else {
                    console.error('Error fetching from Firebase:', error.message);
                }
            }
        }
        
        // Fallback to temp storage if not found in Firebase
        if (!statusData) {
            statusData = tempStatusPages.get(pageId);
        }
        
        if (!statusData) {
            return res.status(404).json({
                success: false,
                error: 'Status page not found'
            });
        }

        // Check if we need to refresh data from Shopify (every 4 hours)
        const lastUpdated = new Date(statusData.lastUpdated);
        const now = new Date();
        const hoursSinceUpdate = (now - lastUpdated) / (1000 * 60 * 60);
        
       if (hoursSinceUpdate >= 4) {
            // Refresh order data from Shopify
            const shopifyResult = await fetchShopifyOrder(statusData.orderNumber);
            
            if (shopifyResult.success) {
                const { order } = shopifyResult;
                
                // Re-fetch metafields for replacement tracking
                const metafieldsResult = await fetchOrderMetafields(order.id);
                const replacementTrackingMetafield = metafieldsResult.replacementTracking;
                
                let effectivePickupDate = statusData.customPickupDate;
                
            // If this was a replacement tracking, preserve the date
                if (statusData.isReplacementTracking && replacementTrackingMetafield) {
                    effectivePickupDate = replacementTrackingMetafield.updated_at; // CHANGED: Use updated_at
                }
                
                // Update carrier info
                const carrierInfo = detectCarrierAndGenerateUrl(statusData.trackingNumber);
                
                // Regenerate events
                const updatedEvents = generateRealisticTrackingEventsWithFulfillment(
                    order.createdAt,
                    order.shippingAddress.city,
                    order.shippingAddress.provinceCode,
                    order.isDelivered,
                    order.deliveryDate,
                    order.fulfillments,
                    effectivePickupDate
                );
                
                // Update stored data
                statusData = {
                    ...statusData,
                    carrier: carrierInfo.carrier,
                    carrierCode: carrierInfo.carrierCode,
                    trackingUrl: carrierInfo.trackingUrl,
                    fulfillmentStatus: order.fulfillmentStatus,
                    isDelivered: order.isDelivered,
                    deliveryDate: order.deliveryDate,
                    events: updatedEvents,
                    lastUpdated: now.toISOString()
                }; 
                
                // Save updated data back to Firebase if it was saved before and Firebase is available
                if (statusData.saved && db) {
                    try {
                        await db.collection('statusPages').doc(pageId).update(statusData);
                    } catch (error) {
                        console.error('Error updating Firebase:', error.message);
                    }
                } else {
                    // Update temp storage
                    tempStatusPages.set(pageId, statusData);
                }
            }
        }
        
        res.json({
            success: true,
            data: statusData
        });
        
    } catch (error) {
        console.error('Error in status endpoint:', error.message);
        // Try temp storage as fallback
        const tempData = tempStatusPages.get(pageId);
        if (tempData) {
            res.json({
                success: true,
                data: tempData
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to retrieve status data'
            });
        }
    }
});

// Favicon route
app.get('/favicon.ico', (req, res) => {
    res.sendFile(__dirname + '/public/favicon.ico');
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📦 Shopify integration: ${SHOPIFY_SHOP_DOMAIN ? '✅ Connected' : '❌ Not configured'}`);
    console.log(`🔥 Firebase integration: ${firebaseInitialized ? '✅ Connected' : '❌ Not configured'}`);
    console.log(`🔐 Admin credentials: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD ? '***' : 'password'}`);
    
    if (!firebaseInitialized) {
        console.log('');
        console.log('🔧 To enable Firebase:');
        console.log('1. Add FIREBASE_SERVICE_ACCOUNT to your .env file');
        console.log('2. Make sure the JSON is valid and private key is properly formatted');
        console.log('3. Restart the server');
        console.log('');
        console.log('📝 App will work without Firebase (temporary pages only)');
    } else {
        console.log('🎉 Ready to create and save status pages!');
    }
    
    console.log('');
    console.log('🔑 Login at: http://localhost:' + PORT + '/login');
    console.log('📊 Admin panel: http://localhost:' + PORT + '/');
});


/* // Add this test endpoint to your server.js
app.get('/api/test-metafields/:orderNumber', requireAuth, async (req, res) => {
    const { orderNumber } = req.params;
    
    try {
        // Clean order number
        const cleanOrderNumber = orderNumber.replace('#', '');
        
        // Search for the order
        let searchUrl = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?name=%23${cleanOrderNumber}&status=any`;
        
        let response = await axios.get(searchUrl, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        // If not found with #, try without
        if (!response.data.orders || response.data.orders.length === 0) {
            searchUrl = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?name=${cleanOrderNumber}&status=any`;
            response = await axios.get(searchUrl, {
                headers: {
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json'
                }
            });
        }

        if (response.data.orders && response.data.orders.length > 0) {
            const order = response.data.orders[0];
            const orderId = order.id;
            
            // Fetch metafields for this order
            const metafieldsUrl = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/metafields.json`;
            
            const metafieldsResponse = await axios.get(metafieldsUrl, {
                headers: {
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json'
                }
            });
            
            // Look for "Replacement Tracking" metafield
            const metafields = metafieldsResponse.data.metafields || [];
            const replacementTracking = metafields.find(m => 
                m.key === 'replacement_tracking' || 
                m.key === 'Replacement Tracking' ||
                m.namespace === 'replacement_tracking'
            );
            
            res.json({
                success: true,
                orderNumber: order.name,
                orderId: orderId,
                allMetafields: metafields,
                replacementTrackingFound: !!replacementTracking,
                replacementTrackingData: replacementTracking || null
            });
            
        } else {
            res.status(404).json({
                success: false,
                error: 'Order not found'
            });
        }
        
    } catch (error) {
        console.error('Metafield test error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data
        });
    }
}); */



/* // Test endpoint to verify replacement tracking date
app.get('/api/test-replacement-date/:orderNumber/:trackingNumber', requireAuth, async (req, res) => {
    const { orderNumber, trackingNumber } = req.params;
    
    try {
        // Fetch order from Shopify
        const shopifyResult = await fetchShopifyOrder(orderNumber);
        
        if (!shopifyResult.success) {
            return res.status(404).json(shopifyResult);
        }

        const { order } = shopifyResult;
        
        // Fetch metafields
        const metafieldsResult = await fetchOrderMetafields(order.id);
        const replacementTrackingMetafield = metafieldsResult.replacementTracking;
        
        // Get main tracking
        const mainTrackingNumber = getMainTrackingNumber(order);
        
        let result = {
            success: true,
            orderNumber: order.name,
            orderId: order.id,
            orderCreatedAt: order.createdAt,
            providedTrackingNumber: trackingNumber,
            mainTrackingNumber: mainTrackingNumber,
            replacementMetafieldFound: !!replacementTrackingMetafield
        };
        
        if (replacementTrackingMetafield) {
            result.replacementTracking = {
                value: replacementTrackingMetafield.value,
                created_at: replacementTrackingMetafield.created_at,
                updated_at: replacementTrackingMetafield.updated_at,
                matchesProvided: trackingNumber === replacementTrackingMetafield.value
            };
            
            // Parse the dates
            const updatedAt = new Date(replacementTrackingMetafield.updated_at);
            const createdAt = new Date(replacementTrackingMetafield.created_at);
            
            result.dateAnalysis = {
                updated_at_raw: replacementTrackingMetafield.updated_at,
                updated_at_parsed: updatedAt.toISOString(),
                updated_at_readable: updatedAt.toLocaleString(),
                created_at_raw: replacementTrackingMetafield.created_at,
                created_at_parsed: createdAt.toISOString(),
                created_at_readable: createdAt.toLocaleString(),
                areDifferent: replacementTrackingMetafield.updated_at !== replacementTrackingMetafield.created_at
            };
        }
        
        // Check which tracking number matches
        if (trackingNumber === mainTrackingNumber) {
            result.trackingType = 'MAIN_TRACKING';
        } else if (replacementTrackingMetafield && trackingNumber === replacementTrackingMetafield.value) {
            result.trackingType = 'REPLACEMENT_TRACKING';
            result.dateToUseForLabel = replacementTrackingMetafield.updated_at;
        } else {
            result.trackingType = 'NO_MATCH';
            result.error = 'Tracking number does not match main or replacement tracking';
        }
        
        res.json(result);
        
    } catch (error) {
        console.error('Test error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
 */
// Export for testing
module.exports = app;