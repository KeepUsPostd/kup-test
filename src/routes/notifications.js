// Notification Routes — In-App Notification Center
// Handles the bell icon / notification drawer in the app.
// GET list, mark read, mark all read, get unread count.
const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const { requireAuth } = require('../middleware/auth');

// All routes require authentication
router.use(requireAuth);

// GET /api/notifications — List notifications (paginated)
// Query params: ?page=1&limit=20&type=content&unreadOnly=true
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = { userId: req.user._id.toString() };

    // Optional type filter
    if (req.query.type) {
      filter.type = req.query.type;
    }

    // Optional audience filter — brand portal passes ?audience=brand to hide influencer-only notifications
    // Excludes notifications explicitly tagged for the OTHER audience (but includes untagged/null ones)
    if (req.query.audience === 'brand') {
      filter.audience = { $ne: 'influencer' };
    } else if (req.query.audience === 'influencer') {
      filter.audience = { $ne: 'brand' };
    }

    // Optional unread-only filter
    if (req.query.unreadOnly === 'true') {
      filter.read = false;
    }

    const unreadFilter = { userId: req.user._id.toString(), read: false };
    // Apply same audience filter to unread count so badge is accurate
    if (req.query.audience === 'brand') {
      unreadFilter.audience = { $ne: 'influencer' };
    } else if (req.query.audience === 'influencer') {
      unreadFilter.audience = { $ne: 'brand' };
    }
    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments(unreadFilter),
    ]);

    res.json({
      notifications,
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching notifications:', error.message);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// GET /api/notifications/unread-count — Badge count for bell icon
router.get('/unread-count', async (req, res) => {
  try {
    const countFilter = { userId: req.user._id.toString(), read: false };
    if (req.query.audience === 'brand') {
      countFilter.audience = { $ne: 'influencer' };
    } else if (req.query.audience === 'influencer') {
      countFilter.audience = { $ne: 'brand' };
    }
    const count = await Notification.countDocuments(countFilter);
    res.json({ unreadCount: count });
  } catch (error) {
    console.error('Error counting notifications:', error.message);
    res.status(500).json({ error: 'Failed to count notifications' });
  }
});

// PUT /api/notifications/:id/read — Mark single notification as read
router.put('/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id.toString() },
      { $set: { read: true, readAt: new Date() } },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ notification });
  } catch (error) {
    console.error('Error marking notification read:', error.message);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// PUT /api/notifications/read-all — Mark all notifications as read
router.put('/read-all', async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user._id.toString(), read: false },
      { $set: { read: true, readAt: new Date() } }
    );

    res.json({ marked: result.modifiedCount });
  } catch (error) {
    console.error('Error marking all read:', error.message);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

module.exports = router;
