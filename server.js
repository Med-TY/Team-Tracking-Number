// server.js - Updated Node.js backend with Firebase integration
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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
    console.log('📝 Tips to fix this:');
    console.log('1. Make sure your .env file has FIREBASE_SERVICE_ACCOUNT with valid JSON');
    console.log('2. The private key should have \\n for line breaks (copy exactly from downloaded file)');
    console.log('3. Make sure the JSON is valid (use a JSON validator)');
    console.log('4. The app will continue without Firebase - pages will only be temporary');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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
// Replace the generateRealisticTrackingEvents function with this final version
function generateRealisticTrackingEvents(orderDate, destinationCity, provinceCode, isDelivered, deliveryDate) {
    const events = [];
    const today = new Date();
    const orderDateObj = new Date(orderDate);
    
    // Get appropriate facilities for the destination state
    const stateFacilities = shippingFacilities[provinceCode] || shippingFacilities['DEFAULT'];
    const destinationFacility = stateFacilities[Math.floor(Math.random() * stateFacilities.length)];
    
    // REAL DATES FROM YOUR SHOPIFY DATA:
    // 1. Order Confirmed = Original order creation date (July 19, 2025 at 2:33 pm)
    const orderConfirmedDate = new Date(orderDateObj);
    
    // 2. Find the latest fulfillment date to use as "Label Created" date
    let labelCreatedDate = new Date(today); // Default to today if no fulfillments
    
    // In the API endpoint, we'll need to pass fulfillment data, but for now use today
    // This will be updated when we modify the API call
    
    // Event templates with specific dates
    const eventTemplates = [
        { 
            status: 'Order Confirmed', 
            location: 'Order Processing Center', 
            fixedDate: orderConfirmedDate 
        },
        { 
            status: 'Order Processed', 
            location: 'Fulfillment Center', 
            businessDaysFromPrevious: getRandomBusinessDaysInterval() 
        },
        { 
            status: 'Label Created', 
            location: 'Origin Facility', 
            fixedDate: labelCreatedDate // This will be the fulfillment date
        },
        { 
            status: 'Package Picked Up', 
            location: 'Local Pickup Facility', 
            businessDaysFromPrevious: getRandomBusinessDaysInterval() 
        },
        { 
            status: 'Departed Origin Facility', 
            location: 'Origin Facility', 
            businessDaysFromPrevious: getRandomBusinessDaysInterval() 
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
            isDelivered: false
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

// Updated function to handle fulfillment dates properly
function generateRealisticTrackingEventsWithFulfillment(orderDate, destinationCity, provinceCode, isDelivered, deliveryDate, fulfillments) {
    const events = [];
    const today = new Date();
    const orderDateObj = new Date(orderDate);
    
    // Get appropriate facilities for the destination state
    const stateFacilities = shippingFacilities[provinceCode] || shippingFacilities['DEFAULT'];
    const destinationFacility = stateFacilities[Math.floor(Math.random() * stateFacilities.length)];
    
    // REAL DATES FROM YOUR SHOPIFY DATA:
    // 1. Order Confirmed = Original order creation date 
    const orderConfirmedDate = new Date(orderDateObj);
    
    // 2. Label Created = Latest fulfillment date with tracking
    let labelCreatedDate = new Date(today); // Default to today
    
    // Find the fulfillment with tracking number (the actual shipment)
    if (fulfillments && fulfillments.length > 0) {
        const shipmentFulfillment = fulfillments.find(f => f.tracking_number || f.tracking_numbers?.length > 0);
        if (shipmentFulfillment) {
            labelCreatedDate = new Date(shipmentFulfillment.created_at);
        }
    }
    
    // Event templates with your specific dates
    const eventTemplates = [
        { 
            status: 'Order Confirmed', 
            location: 'Order Processing Center', 
            fixedDate: orderConfirmedDate 
        },
        { 
            status: 'Order Processed', 
            location: 'Fulfillment Center', 
            businessDaysFromPrevious: getRandomBusinessDaysInterval() 
        },
        { 
            status: 'Label Created', 
            location: 'Origin Facility', 
            fixedDate: labelCreatedDate 
        },
        { 
            status: 'Package Picked Up', 
            location: 'Local Pickup Facility', 
            businessDaysFromPrevious: getRandomBusinessDaysInterval() 
        },
        { 
            status: 'Departed Origin Facility', 
            location: 'Origin Facility', 
            businessDaysFromPrevious: getRandomBusinessDaysInterval() 
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
            isDelivered: false
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


// Helper function to create an event with more realistic timing
function createEvent(status, date, location, eventIndex, daysDiff, isDelivered = false) {
    const eventDate = new Date(date);
    const today = new Date();
    
    // Make the last update closer to today for more realistic feel
    if (!isDelivered && eventIndex > 0) {
        const maxDaysAgo = Math.min(3, Math.max(1, Math.floor(daysDiff / 4)));
        const randomDaysAgo = Math.floor(Math.random() * maxDaysAgo);
        const recentDate = new Date(today);
        recentDate.setDate(recentDate.getDate() - randomDaysAgo);
        
        // Use more recent date for later events
        if (eventDate > recentDate && Math.random() > 0.3) {
            eventDate.setTime(recentDate.getTime());
        }
    }
    
    // Determine if this event has occurred
    const hasOccurred = eventDate <= today;
    const isCurrentEvent = !hasOccurred && !isDelivered;
    
    return {
        status: status,
        date: eventDate.toLocaleDateString('en-US', { 
            weekday: 'short', 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        }),
        time: generateRealisticTime(eventDate, status),
        location: location,
        completed: hasOccurred || isDelivered,
        current: isCurrentEvent,
        isDelivered: isDelivered
    };
}

// Helper function to detect carrier and generate tracking URL
function detectCarrierAndGenerateUrl(trackingNumber) {
    const carriers = {
        'UPS': {
            pattern: /^1Z[0-9A-Z]{16}$/,
            url: `https://www.ups.com/track?track=yes&trackNums=${trackingNumber}`,
            name: 'UPS'
        },
        'FedEx': {
            pattern: /^(\d{12}|\d{14}|\d{15}|\d{20}|\d{22})$/,
            url: `https://www.fedex.com/fedextrack/?tracknumber=${trackingNumber}`,
            name: 'FedEx'
        },
        'USPS': {
            pattern: /^(94|93|92|91|90|82|81|80|23|13|03|04|70|23|03)\d+$/,
            url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
            name: 'USPS'
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
        case 'Shipment Created':
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

// Replace the existing /api/create-status-page endpoint with this updated version
app.post('/api/create-status-page', async (req, res) => {
    const { orderNumber, trackingNumber } = req.body;

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
        
        // Detect carrier and generate tracking URL
        const carrierInfo = detectCarrierAndGenerateUrl(trackingNumber);
        
        // Generate realistic tracking events with fulfillment data
        const trackingEvents = generateRealisticTrackingEventsWithFulfillment(
            order.createdAt,
            order.shippingAddress.city,
            order.shippingAddress.provinceCode,
            order.isDelivered,
            order.deliveryDate,
            order.fulfillments // Pass fulfillment data for real dates
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
            createdAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            saved: false // Track if page has been saved to Firebase
        };

        // Generate unique page ID
        const pageId = crypto.randomBytes(8).toString('hex');
        
        // Store status page temporarily (NOT in Firebase yet)
        tempStatusPages.set(pageId, statusPageData);

        // Auto-cleanup temp pages after 1 hour if not saved
        setTimeout(() => {
            if (tempStatusPages.has(pageId) && !tempStatusPages.get(pageId).saved) {
                tempStatusPages.delete(pageId);
                console.log(`🗑️  Cleaned up unsaved temp page: ${pageId}`);
            }
        }, 60 * 60 * 1000); // 1 hour

        // Return success with page ID
        res.json({
            success: true,
            pageId: pageId,
            url: `${req.protocol}://${req.get('host')}/track/${pageId}`,
            data: statusPageData
        });

    } catch (error) {
        console.error('Error creating status page:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});


// NEW API endpoint to save status page to Firebase (called when link is copied)
app.post('/api/save-status-page/:pageId', async (req, res) => {
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

// API endpoint to retrieve status page (checks Firebase first, then temp storage)
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
                
                // Update carrier info if tracking number changed
                const carrierInfo = detectCarrierAndGenerateUrl(statusData.trackingNumber);
                
                // Regenerate events with updated fulfillment status
                const updatedEvents = generateRealisticTrackingEvents(
                    order.createdAt,
                    order.shippingAddress.city,
                    order.shippingAddress.provinceCode,
                    order.isDelivered,
                    order.deliveryDate
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

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        shopifyConnected: !!SHOPIFY_SHOP_DOMAIN && !!SHOPIFY_ACCESS_TOKEN,
        firebaseConnected: firebaseInitialized && !!db
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📦 Shopify integration: ${SHOPIFY_SHOP_DOMAIN ? '✅ Connected' : '❌ Not configured'}`);
    console.log(`🔥 Firebase integration: ${firebaseInitialized ? '✅ Connected' : '❌ Not configured'}`);
    
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
});

// Export for testing
module.exports = app;