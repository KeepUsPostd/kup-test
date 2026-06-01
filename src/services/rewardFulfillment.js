// Reward Fulfillment — resolves the deliverable for a reward at approval time.
// The PLATFORM delivers it to the creator via the approval notification
// (email + in-app + push), so the brand never needs the creator's email/PII.
// Generic across reward types. Ref: REWARD_DELIVERY.md
const Reward = require('../models/Reward');

// Resolve a creator-facing deliverable for a reward, or null if nothing to send.
// Returns: { method, url?, fileUrl?, code?, instructions?, claim?, exhausted? }
async function resolveDeliverable(reward, influencerProfileId) {
  const f = reward && reward.fulfillment;
  if (!f || !f.method || f.method === 'none') return null;

  const base = { method: f.method, instructions: f.instructions || null };

  switch (f.method) {
    case 'link':
      return f.url ? { ...base, url: f.url } : null;

    case 'file':
      return f.fileUrl ? { ...base, fileUrl: f.fileUrl } : null;

    case 'code':
      return f.code ? { ...base, code: f.code } : null;

    case 'code_pool': {
      // Atomically claim the next unused code for this creator (positional `$`
      // updates the first array element matching usedBy:null).
      const upd = await Reward.findOneAndUpdate(
        { _id: reward._id, 'fulfillment.codePool': { $elemMatch: { usedBy: null } } },
        {
          $set: {
            'fulfillment.codePool.$.usedBy': influencerProfileId,
            'fulfillment.codePool.$.usedAt': new Date(),
          },
        },
        { new: true },
      ).lean();
      if (!upd) return { ...base, code: null, exhausted: true }; // pool empty
      // Pick this creator's most-recently-assigned code.
      const mine = (upd.fulfillment.codePool || [])
        .filter(c => String(c.usedBy) === String(influencerProfileId) && c.usedAt)
        .sort((a, b) => new Date(b.usedAt) - new Date(a.usedAt));
      return mine[0] ? { ...base, code: mine[0].code } : null;
    }

    case 'pickup':
      // No digital payload — staff hands it over after scanning the creator's
      // existing profile QR (staff-lookup). We surface a "claim in person" note.
      return { ...base, claim: 'pickup' };

    case 'address':
      // Physical ship — creator confirms address (consented) via a linked form.
      return { ...base, claim: 'address' };

    default:
      return null;
  }
}

module.exports = { resolveDeliverable };
