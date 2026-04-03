// PurchasePointsConfig Model
// Stores a brand's 3-tier spend-to-points configuration for both in-store and online channels.
//
// Tier logic: customer earns points for the HIGHEST level their spend reaches or exceeds.
// Example: levels [{minSpend:25,pts:75},{minSpend:50,pts:150},{minSpend:75,pts:200}]
//   - Spend $30 → Level 1 (75 pts)
//   - Spend $55 → Level 2 (150 pts)
//   - Spend $80 → Level 3 (200 pts)
//   - Spend $15 → 0 pts (below floor)
//   - Spend $120 → Level 3 (200 pts — maxes out, no stacking)
const mongoose = require('mongoose');

const levelSchema = new mongoose.Schema({
  minSpend: { type: Number, required: true, min: 0 },   // $ threshold customer must reach
  points:   { type: Number, required: true, min: 1 },   // flat points awarded at this level
}, { _id: false });

const channelSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  levels: {
    type: [levelSchema],
    validate: {
      validator: v => v.length <= 3,
      message: 'Maximum 3 purchase point levels allowed.',
    },
    default: [],
  },
}, { _id: false });

const purchasePointsConfigSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
    unique: true,
  },
  inStore: { type: channelSchema, default: () => ({ enabled: true, levels: [] }) },
  online:  { type: channelSchema, default: () => ({ enabled: false, levels: [] }) },
}, { timestamps: true });

purchasePointsConfigSchema.index({ brandId: 1 });

// ── Helper: calculate points for a given spend amount and level array ──────────
// Returns { points, levelIndex } where levelIndex is 1-3 (or 0 if no match)
purchasePointsConfigSchema.statics.calculatePoints = function(spendAmount, levels) {
  if (!levels || !levels.length) return { points: 0, levelIndex: 0 };
  // Sort levels highest-threshold first → find first one the spend qualifies for
  const sorted = [...levels]
    .map((l, i) => ({ ...l.toObject ? l.toObject() : l, originalIndex: i + 1 }))
    .filter(l => l.minSpend > 0 && l.points > 0)
    .sort((a, b) => b.minSpend - a.minSpend);
  const match = sorted.find(l => spendAmount >= l.minSpend);
  return match
    ? { points: match.points, levelIndex: match.originalIndex }
    : { points: 0, levelIndex: 0 };
};

module.exports = mongoose.model('PurchasePointsConfig', purchasePointsConfigSchema);
