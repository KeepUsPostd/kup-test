// KUP Push Notification Service — Firebase Cloud Messaging (FCM)
// Sends native push notifications to iOS/Android devices.
// FCM is free and included with your Firebase project.
//
// Usage:
//   const { sendPush, sendPushToUser } = require('../config/push');
//   await sendPushToUser(userId, { title: 'Content Approved!', body: 'You earned $8!' });

const admin = require('./firebase');

// ── Send push to a single device token ──────────────────
async function sendPush({ token, title, body, data = {}, badge = null }) {
  if (!token) return { success: false, reason: 'no_token' };

  try {
    const message = {
      token,
      notification: {
        title,
        body,
      },
      data: {
        // All data values must be strings for FCM
        ...Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
      },
      // iOS-specific config
      apns: {
        payload: {
          aps: {
            sound: 'default',
            ...(badge !== null ? { badge } : {}),
          },
        },
      },
      // Android-specific config
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'kup_default',
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log(`📱 Push sent: "${title}" → token:${token.slice(0, 12)}...`);
    return { success: true, messageId: response };
  } catch (error) {
    // Handle invalid/expired tokens gracefully
    if (
      error.code === 'messaging/invalid-registration-token' ||
      error.code === 'messaging/registration-token-not-registered'
    ) {
      console.log(`📱 Push token expired/invalid: ${token.slice(0, 12)}... — should remove`);
      return { success: false, reason: 'token_expired', token };
    }

    console.error(`📱 Push failed:`, error.code || error.message);
    return { success: false, reason: error.message };
  }
}

// ── Send push to all devices for a user ─────────────────
// Looks up device tokens from the User model's fcmTokens array
async function sendPushToUser(userId, { title, body, data = {}, link = null }) {
  // Lazy-load User model to avoid circular dependency
  const User = require('../models/User');

  try {
    const user = await User.findOne(
      { $or: [{ _id: userId }, { firebaseUid: userId }] },
      { fcmTokens: 1 }
    );

    if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
      return { success: false, reason: 'no_tokens', sent: 0 };
    }

    // Add link to data payload so the app can navigate on tap
    if (link) data.link = link;

    const results = await Promise.allSettled(
      user.fcmTokens.map(tokenObj =>
        sendPush({
          token: tokenObj.token,
          title,
          body,
          data,
        })
      )
    );

    // Collect expired tokens for cleanup
    const expiredTokens = results
      .filter(r => r.status === 'fulfilled' && r.value.reason === 'token_expired')
      .map(r => r.value.token);

    // Remove expired tokens from user record
    if (expiredTokens.length > 0) {
      await User.updateOne(
        { _id: user._id },
        { $pull: { fcmTokens: { token: { $in: expiredTokens } } } }
      );
      console.log(`📱 Cleaned ${expiredTokens.length} expired token(s) for user ${userId}`);
    }

    const sent = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    return { success: sent > 0, sent, total: user.fcmTokens.length };
  } catch (error) {
    console.error(`📱 Push to user ${userId} failed:`, error.message);
    return { success: false, reason: error.message, sent: 0 };
  }
}

// ── Send push to multiple users ─────────────────────────
async function sendPushToUsers(userIds, { title, body, data = {}, link = null }) {
  const results = await Promise.allSettled(
    userIds.map(uid => sendPushToUser(uid, { title, body, data, link }))
  );

  const sent = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  return { sent, total: userIds.length };
}

module.exports = { sendPush, sendPushToUser, sendPushToUsers };
