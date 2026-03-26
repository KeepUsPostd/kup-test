// Brand Access Middleware
// Checks that req.user has the required role on a brand
// Enforces platform rule G1: Brand isolation
const { BrandMember } = require('../models');

// Role hierarchy (higher index = more permissions)
const ROLE_HIERARCHY = ['viewer', 'location_manager', 'manager', 'admin', 'owner'];

// requireBrandRole — checks user has at minimum the specified role
// Usage: router.put('/:brandId', requireAuth, requireBrandRole('admin'), handler)
const requireBrandRole = (minimumRole) => {
  return async (req, res, next) => {
    try {
      const { brandId } = req.params;

      if (!brandId) {
        return res.status(400).json({
          error: 'Missing brand ID',
          message: 'A brand ID is required for this action.',
        });
      }

      // Find the user's membership for this brand
      const membership = await BrandMember.findOne({
        brandId,
        userId: req.user._id,
        status: 'active',
      });

      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You do not have access to this brand.',
        });
      }

      // Check role hierarchy
      const userRoleIndex = ROLE_HIERARCHY.indexOf(membership.role);
      const requiredRoleIndex = ROLE_HIERARCHY.indexOf(minimumRole);

      if (userRoleIndex < requiredRoleIndex) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: `This action requires ${minimumRole} access or higher.`,
        });
      }

      // Attach membership to request for downstream use
      req.brandMembership = membership;
      next();
    } catch (error) {
      console.error('Brand access check error:', error.message);
      return res.status(500).json({
        error: 'Server error',
        message: 'Could not verify brand access.',
      });
    }
  };
};

module.exports = { requireBrandRole, ROLE_HIERARCHY };
