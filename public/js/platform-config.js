/**
 * KeepUsPostd — Platform Configuration
 * =====================================
 * This file defines ALL platform-level rules, constraints, and architectural decisions
 * for the entire KUP platform — not just rewards.
 *
 * DEVELOPER NOTE:
 * These rules are the product architecture — they are NOT suggestions.
 * Every validation, UI gate, and data model must enforce these constraints.
 * If you need to change a rule, it requires product owner approval (Santana Thrasybule).
 *
 * Architecture doc: /brands/KeepUsPostd/product/PLATFORM_ARCHITECTURE.md
 * Reward-specific doc: /brands/KeepUsPostd/product/REWARD_SYSTEM_ARCHITECTURE.md
 * Last updated: 2026-03-05
 */

var KUP_PLATFORM = (function() {
  'use strict';


  // ================================================================
  //  SECTION 1: DESIGN SYSTEM
  // ================================================================
  // Core visual tokens used across the entire platform.
  // All components must reference these — never hardcode colors/fonts.

  var DESIGN = {
    colors: {
      orange:   '#ED8444',
      blue:     '#2EA5DD',
      purple:   '#707BBB',
      black:    '#000000',
      white:    '#FFFFFF',
      bodyBg:   '#F5F6FA',
      success:  '#16a34a',
      error:    '#dc2626',
      warning:  '#f59e0b',
      gradient: 'linear-gradient(135deg, #2EA5DD 0%, #707BBB 100%)'
    },
    font: "'Montserrat', sans-serif",
    radius: { sm: '6px', md: '12px' },
    framework: 'Bootstrap 5.3.3'  // CDN, no custom build
  };


  // ================================================================
  //  SECTION 2: PRICING TIERS & PLAN LIMITS
  // ================================================================
  // The entire platform is gated by these 5 tiers.
  // Every feature check must go through canAccess().

  // 14-day free trial: full Pro access, no CC required.
  // After trial expires, user is downgraded to Starter.
  var TRIAL = {
    durationDays: 14,
    tier: 'pro',        // What they get during trial
    requiresCC: false,  // No credit card needed to start
    fallbackTier: 'starter',  // Where they land after expiry
  };

  var PRICING_TIERS = {
    starter: {
      price: 0,
      label: 'Starter',
      badge: 'Free',
      limits: {
        brands: 1,
        campaignsPerBrand: 1,
        influencers: 10,
        adminSeats: 1,        // Owner only
        storageGB: 1
      },
      features: [
        'non-cash-rewards', 'point-based', 'per-approval'
      ]
    },
    growth: {
      price: 29,
      label: 'Growth',
      badge: '$29/mo',
      popular: true,          // "Most Popular" badge on pricing page
      limits: {
        brands: 3,
        campaignsPerBrand: 5,
        influencers: 100,
        adminSeats: 3,
        storageGB: 10
      },
      features: [
        'non-cash-rewards', 'point-based', 'per-approval',
        'cash-per-approval', 'bonus-cash', 'postd-pay',
        'discovery-browse'
      ]
    },
    pro: {
      price: 79,
      label: 'Pro',
      badge: '$79/mo',
      limits: {
        brands: 10,
        campaignsPerBrand: 20,
        influencers: 500,
        adminSeats: 10,
        storageGB: 50
      },
      features: [
        'non-cash-rewards', 'point-based', 'per-approval',
        'cash-per-approval', 'bonus-cash', 'postd-pay',
        'discovery-advanced'
      ]
    },
    agency: {
      price: 149,
      label: 'Agency',
      badge: '$149/mo',
      limits: {
        brands: 25,
        campaignsPerBrand: 50,
        influencers: 2000,     // Shared pool across brands
        adminSeats: 25,
        storageGB: 200
      },
      features: [
        'non-cash-rewards', 'point-based', 'per-approval',
        'cash-per-approval', 'bonus-cash', 'postd-pay',
        'discovery-full', 'brand-assignment',
        'agency-access-levels', 'agency-shield',
        'multi-brand-management', 'white-label'
      ]
    },
    enterprise: {
      price: 'custom',
      label: 'Enterprise',
      badge: 'Custom',
      limits: {
        brands: -1,            // -1 = unlimited
        campaignsPerBrand: -1,
        influencers: -1,
        adminSeats: -1,
        storageGB: -1
      },
      features: [
        'non-cash-rewards', 'point-based', 'per-approval',
        'cash-per-approval', 'bonus-cash', 'postd-pay',
        'discovery-ai', 'brand-assignment',
        'agency-access-levels', 'agency-shield',
        'multi-brand-management', 'white-label',
        'api-access', 'sso-saml', 'dedicated-am'
      ]
    }
  };

  function canAccess(tierKey, featureKey) {
    var tier = PRICING_TIERS[tierKey];
    if (!tier) return false;
    return tier.features.indexOf(featureKey) >= 0;
  }

  function getPlanLimit(tierKey, limitKey) {
    var tier = PRICING_TIERS[tierKey];
    if (!tier) return 0;
    var val = tier.limits[limitKey];
    return (val === -1) ? Infinity : (val || 0);
  }


  // ================================================================
  //  SECTION 3: ADMIN ROLES & PERMISSIONS
  // ================================================================
  // 4-tier role system for team access. Enforced on owner-account.html.
  // Roles are per-brand — a user can have different roles on different brands.

  var ADMIN_ROLES = {
    owner: {
      label: 'Owner',
      icon: '🔑',
      color: '#ED8444',
      description: 'Full access to all features, billing, team management, and account transfer',
      permissions: {
        manageBilling: true,
        manageTeam: true,
        transferAccount: true,
        manageCampaigns: true,
        approveContent: true,
        manageInfluencers: true,
        manageRewards: true,
        viewAnalytics: true,
        exportData: true,
        manageBrandSettings: true
      },
      rules: {
        maxPerBrand: 1,          // Exactly 1 owner per brand — non-negotiable
        canBeRemoved: false,     // Owner can only transfer, not be removed
        canTransferTo: ['admin'] // Can only transfer ownership to an Admin
      }
    },
    admin: {
      label: 'Admin',
      icon: '⚙️',
      color: '#2EA5DD',
      description: 'Full access to campaigns, content, influencers, and rewards — no billing access',
      permissions: {
        manageBilling: false,
        manageTeam: false,
        transferAccount: false,
        manageCampaigns: true,
        approveContent: true,
        manageInfluencers: true,
        manageRewards: true,
        viewAnalytics: true,
        exportData: true,
        manageBrandSettings: true
      },
      rules: {
        maxPerBrand: -1,         // Unlimited, gated by plan's adminSeats
        canBeRemoved: true
      }
    },
    manager: {
      label: 'Manager',
      icon: '📋',
      color: '#707BBB',
      description: 'Manage campaigns, approve content, and handle influencer communications',
      permissions: {
        manageBilling: false,
        manageTeam: false,
        transferAccount: false,
        manageCampaigns: true,
        approveContent: true,
        manageInfluencers: true,
        manageRewards: false,
        viewAnalytics: true,
        exportData: false,
        manageBrandSettings: false
      },
      rules: {
        maxPerBrand: -1,
        canBeRemoved: true
      }
    },
    viewer: {
      label: 'Viewer',
      icon: '👁',
      color: '#888888',
      description: 'Read-only access to dashboards, analytics, and reports — no editing',
      permissions: {
        manageBilling: false,
        manageTeam: false,
        transferAccount: false,
        manageCampaigns: false,
        approveContent: false,
        manageInfluencers: false,
        manageRewards: false,
        viewAnalytics: true,
        exportData: false,
        manageBrandSettings: false
      },
      rules: {
        maxPerBrand: -1,
        canBeRemoved: true
      }
    }
  };

  function hasPermission(role, permissionKey) {
    var r = ADMIN_ROLES[role];
    return r && r.permissions[permissionKey] === true;
  }


  // ================================================================
  //  SECTION 4: AGENCY ACCESS LEVELS (Brand Management)
  // ================================================================
  // Agency-plan feature. Controls how much access brand clients get.
  // Set per-brand in manage-brands.html → Brand Settings modal.

  var AGENCY_ACCESS_LEVELS = {
    'agency-managed': {
      label: 'Agency Managed',
      isDefault: true,
      description: 'Brand has no platform access. Agency exports content and delivers externally.',
      shieldAvailable: true,
      features: {
        brandLogin: false,
        viewDashboard: false,
        approveContent: false,
        messageInfluencers: false,
        exportContent: true,
        exportReports: true,
        exportAnalytics: true
      }
    },
    'view-only': {
      label: 'View Only',
      isDefault: false,
      description: 'Brand gets a read-only dashboard link. Cannot take actions.',
      shieldAvailable: false,
      features: {
        brandLogin: true,
        viewDashboard: true,
        approveContent: false,
        messageInfluencers: false,
        exportContent: false,
        exportReports: false,
        exportAnalytics: false
      }
    },
    'collaborative': {
      label: 'Collaborative',
      isDefault: false,
      description: 'Brand client can approve, reject, and message influencers.',
      shieldAvailable: false,
      features: {
        brandLogin: true,
        viewDashboard: true,
        approveContent: true,
        messageInfluencers: true,
        exportContent: true,
        exportReports: true,
        exportAnalytics: false
      }
    }
  };

  /**
   * AGENCY SHIELD
   * Only available in Agency Managed mode.
   * When ON: All influencer communication routes through agency inbox.
   * Purpose: Disintermediation protection — influencers know the brand name
   * (required for authentic content) but cannot contact the brand directly.
   * The agency stays in the middle.
   */
  var AGENCY_SHIELD = {
    availableIn: 'agency-managed',
    defaultState: true,
    protects: ['direct-messaging', 'contact-info-sharing', 'brand-influencer-bypass']
  };


  // ================================================================
  //  SECTION 5: CONTENT LIFECYCLE
  // ================================================================
  // Content follows a strict linear pipeline. No status can be skipped.

  var CONTENT_STATUSES = {
    'submitted': {
      label: 'Pending',
      badgeClass: 'pending',
      color: '#856404',
      bgColor: '#FFF3CD',
      description: 'Influencer has submitted content, awaiting brand review'
    },
    'approved': {
      label: 'Approved',
      badgeClass: 'approved',
      color: '#0f5132',
      bgColor: '#D1E7DD',
      description: 'Brand has approved the content for publishing'
    },
    'rejected': {
      label: 'Rejected',
      badgeClass: 'rejected',
      color: '#842029',
      bgColor: '#F8D7DA',
      description: 'Brand has rejected the content with feedback'
    },
    'postd': {
      label: 'Postd',
      badgeClass: 'postd',
      color: '#1a5e99',
      bgColor: '#D0E7FF',
      description: 'Content has been published/posted by the brand'
    }
  };

  /**
   * Valid status transitions. Backend must enforce these.
   * submitted → approved | rejected
   * approved  → postd
   * rejected  → (terminal, but influencer can resubmit as new entry)
   * postd     → (terminal)
   */
  var CONTENT_TRANSITIONS = {
    'submitted': ['approved', 'rejected'],
    'approved':  ['postd'],
    'rejected':  [],
    'postd':     []
  };

  var CONTENT_RULES = {
    REJECTED_CAN_RESUBMIT: true,     // Influencer can submit NEW content after rejection
    REJECTION_REQUIRES_FEEDBACK: true, // Brand must provide reason when rejecting
    APPROVAL_TRIGGERS_REWARDS: true,   // Content approval fires reward evaluation
    POSTD_TRIGGERS_BONUS: true,        // "Postd" status triggers Bonus Cash check (if enabled)
    AUTO_APPROVE_ENABLED: true,        // Content auto-approves after deadline to respect influencer
    AUTO_APPROVE_DAYS: 10              // Days before auto-approve fires (brand has 10 days to decide)
  };


  // ================================================================
  //  SECTION 6: CAMPAIGN SYSTEM
  // ================================================================

  var CAMPAIGN_STATUSES = {
    'draft':  { label: 'Draft',  color: '#888',    description: 'Not yet published to influencers' },
    'active': { label: 'Active', color: '#16a34a',  description: 'Live and accepting submissions' },
    'paused': { label: 'Paused', color: '#f59e0b',  description: 'Temporarily halted, can be reactivated' },
    'ended':  { label: 'Ended',  color: '#dc2626',  description: 'Campaign period is over' }
  };

  var CAMPAIGN_TRANSITIONS = {
    'draft':  ['active'],
    'active': ['paused', 'ended'],
    'paused': ['active', 'ended'],
    'ended':  []                     // Terminal — cannot reactivate a completed campaign
  };

  var CAMPAIGN_RULES = {
    REQUIRES_AT_LEAST_ONE_REWARD: true,  // Campaign must have a reward attached
    MAX_REWARDS_PER_CAMPAIGN: 3,          // Max 3 active rewards per campaign
    DRAFT_CAN_BE_DELETED: true,           // Only drafts can be deleted
    ACTIVE_CANNOT_BE_DELETED: true,       // Active/paused campaigns must be ended first
    ENDED_RETAINED_DAYS: 365              // Data kept for 1 year after campaign ends
  };


  // ================================================================
  //  SECTION 7: INFLUENCER MANAGEMENT
  // ================================================================

  var INFLUENCER_TABS = {
    'my-influencers': { label: 'My Influencers', description: 'Active partner influencers' },
    'requests':       { label: 'Requests',       description: 'Pending partnership requests', showBadge: true },
    'invited':        { label: 'Invited',        description: 'Sent invitations awaiting response' },
    'discovery':      { label: 'Discovery',      description: 'Browse and invite new influencers', isNew: true }
  };

  var INFLUENCE_TIERS = {
    nano:      { label: 'Nano Influencer',  followers: '1K–10K',    color: '#707BBB', badgeClass: 'micro' },
    micro:     { label: 'Micro Influencer', followers: '10K–50K',   color: '#707BBB', badgeClass: 'micro' },
    rising:    { label: 'Rising',           followers: '15K–30K',   color: '#2EA5DD', badgeClass: 'rising' },
    established: { label: 'Established',    followers: '30K–100K',  color: '#ED8444', badgeClass: 'established' },
    premium:   { label: 'Premium',          followers: '100K+',     color: '#16a34a', badgeClass: 'premium' }
  };

  var INFLUENCER_RULES = {
    TIER_ASSIGNED_ON_JOIN: true,          // Tier set when influencer joins, based on follower count
    TIER_RECALCULATED_MONTHLY: true,      // Re-evaluated every 30 days
    INVITE_REQUIRES_EMAIL_OR_HANDLE: true, // Must provide contact method
    PARTNERSHIP_IS_PER_BRAND: true,        // Influencer-brand is a unique relationship
    SAME_INFLUENCER_MULTI_BRAND: true      // Same influencer can partner with multiple brands
  };

  var DISCOVERY_TIERS = {
    starter:    { enabled: false, label: 'Not available' },
    growth:     { enabled: true,  label: 'Browse profiles',                    filters: false, engagement: false, aiMatch: false },
    pro:        { enabled: true,  label: 'Advanced filters + engagement data', filters: true,  engagement: true,  aiMatch: false },
    agency:     { enabled: true,  label: 'Full + assign to brands',            filters: true,  engagement: true,  aiMatch: false, brandAssign: true },
    enterprise: { enabled: true,  label: 'Full + AI-powered matching',         filters: true,  engagement: true,  aiMatch: true,  brandAssign: true }
  };


  // ================================================================
  //  SECTION 8: REWARD SYSTEM
  // ================================================================

  var REWARD_TYPES = {
    'points':            { lane: 'non-cash', label: 'Points / Store Credit',   icon: '⭐', requiresEarningMethod: true },
    'free-product':      { lane: 'non-cash', label: 'Free Product or Service', icon: '🎁', requiresEarningMethod: true },
    'discount':          { lane: 'non-cash', label: 'Discount / Coupon',       icon: '🏷️', requiresEarningMethod: true },
    'cash-per-approval': { lane: 'cash',     label: 'Cash Per Approval',       icon: '💰', requiresEarningMethod: false },
    'bonus-cash':        { lane: 'cash',     label: 'Bonus Cash',              icon: '🎯', requiresEarningMethod: false },
    'postd-pay':         { lane: 'cash',     label: 'Postd Pay',              icon: '💸', requiresEarningMethod: false }
  };

  var EARNING_METHODS = {
    'point-based': {
      label: 'Point-Based',
      description: 'Influencers accumulate points to unlock this reward',
      bestFor: 'Repeat traffic, loyalty programs',
      requiresConfig: true
    },
    'per-approval': {
      label: 'Per Approval',
      description: 'Reward triggers instantly when you approve content',
      bestFor: 'Events, conferences, one-off offers',
      requiresConfig: false
    }
  };

  var REWARD_RULES = {
    /**
     * RULE R1: One earning method per reward.
     * Cannot use both Point-Based AND Per Approval on the same reward.
     */
    ONE_EARNING_METHOD_PER_REWARD: true,

    /**
     * RULE R2: No point pooling across rewards.
     * Points for Reward A never count toward Reward B.
     * Each reward has its own independent progress per influencer.
     */
    POINTS_ARE_PER_REWARD: true,

    /**
     * RULE R3: No auto-stacking cash on non-cash.
     * Cash + non-cash on the same trigger = two separate rewards, not auto-combined.
     */
    NO_AUTO_STACK_CASH_ON_NONCASH: true,

    /**
     * RULE R4: Cash amounts are tier-based, not brand-defined.
     * CPA and Bonus Cash rates come from influencer's tier. Brands don't set amounts.
     * Exception: Postd Pay is manual/custom.
     */
    CASH_RATES_ARE_TIER_BASED: true,

    /**
     * RULE R5: Cash types allow multi-select per reward config.
     * Brand can enable CPA + Bonus + Postd Pay together.
     */
    CASH_MULTI_SELECT: true,

    /**
     * RULE R6: Non-cash types are exclusive per reward.
     * One non-cash type per reward. Create multiple rewards for variety.
     */
    NONCASH_EXCLUSIVE_PER_REWARD: true
  };

  var POINT_CATEGORIES = {
    content: {
      label: 'Content Points',
      emoji: '🎬',
      subtitle: 'Reviews & submissions',
      defaultEnabled: true,
      activities: [
        { key: 'submitted',  label: 'Submitted to brand',              defaultValue: 10 },
        { key: 'approved',   label: 'Approved by brand',               defaultValue: 25 },
        { key: 'published',  label: 'Published by brand',              defaultValue: 40 },
        { key: 'bonus',      label: 'Bonus (posted to own community)', defaultValue: 15 }
      ]
    },
    purchase: {
      label: 'Purchase Points',
      emoji: '🛒',
      subtitle: 'Replaces traditional punch cards',
      defaultEnabled: false,
      tiers: 3,
      tierStructure: { spend: 'dollar', earn: 'points' }
    },
    gratitude: {
      label: 'Gratitude Points',
      emoji: '🎉',
      subtitle: 'Milestones & celebrations',
      defaultEnabled: false,
      activities: [
        { key: 'join',        label: 'Joins as influencer',     defaultValue: 50 },
        { key: 'birthday',    label: 'Birthday',                defaultValue: 25 },
        { key: 'anniversary', label: 'Partnership anniversary', defaultValue: 100 }
      ]
    }
  };

  var POINT_RULES = {
    MIN_CATEGORIES_ENABLED: 1,
    THRESHOLD_MIN: 1,
    THRESHOLD_DEFAULT: 500,
    POINTS_EXPIRE: false,
    ALLOW_NEGATIVE_POINTS: false,
    ALLOW_POINT_TRANSFER: false
  };

  // Reward wizard step logic
  function getWizardSteps(rewardType, earningMethod) {
    var type = REWARD_TYPES[rewardType];
    if (!type) return 3;
    if (type.lane === 'cash') return 3;
    if (type.requiresEarningMethod && earningMethod === 'point-based') return 4;
    return 3;
  }

  function showsEarningStep(rewardType) {
    var type = REWARD_TYPES[rewardType];
    return type && type.lane === 'non-cash';
  }

  function needsPointConfig(rewardType, earningMethod) {
    var type = REWARD_TYPES[rewardType];
    return type && type.lane === 'non-cash' && earningMethod === 'point-based';
  }

  function isCashType(rewardType) {
    var type = REWARD_TYPES[rewardType];
    return type && type.lane === 'cash';
  }


  // ================================================================
  //  SECTION 9: CASH & PAYMENTS
  // ================================================================

  var PAYMENT_CONFIG = {
    processor: 'PayPal Business',
    currency: 'USD',

    /**
     * Cash payout is resolved from influencer's tier, not brand-defined.
     * Actual tier rates are managed in platform admin settings.
     */
    rateSource: 'influence-tier',

    /**
     * Postd Pay is the ONLY cash type where the brand sets the amount manually.
     * No triggers, no limits, no tier calculation.
     */
    postdPayIsManual: true,

    /**
     * Budget caps are optional per Bonus Cash reward config.
     * When the total paid hits the cap, bonuses stop. No overage.
     */
    budgetCapEnforced: true,

    // ── Fee Structure ──────────────────────────────────
    // Deducted at the moment the brand pays the influencer.
    // Influencer receives the clean whole-dollar amount after both fees.
    fees: {
      paypal: { percent: 0.0299, flat: 0.49 },  // PayPal card transaction fee
      kup:    { flat: 0.50 }                     // KUP platform fee per transaction
    },

    // ── Tier-Based Pay Rates ───────────────────────────
    // Rule G7: Brands cannot override these — rates come from influencer tier.
    // brandPays = (influencerGets + kupFee + paypalFlat) / (1 - paypalPercent)
    // Bonus Cash = 30% of the influencer's base pay (paid separately).
    //
    // Model tier names → display names:
    //   unverified → Startup | nano → Nano | micro → Micro
    //   rising → Mid | established → Macro | premium → Mega
    //   celebrity → Celebrity (requires model enum update)
    bonusCashPercent: 0.30,

    tierRates: {
      unverified: {
        displayName: 'Startup',
        followerRange: '0–5k',
        video: { influencerGets: 4,  brandPays: 5.14  },
        image: { influencerGets: 2,  brandPays: 3.08  }
      },
      startup: {
        displayName: 'Startup',
        followerRange: '0–5k',
        video: { influencerGets: 4,  brandPays: 5.14  },
        image: { influencerGets: 2,  brandPays: 3.08  }
      },
      nano: {
        displayName: 'Nano',
        followerRange: '5k–10k',
        video: { influencerGets: 8,  brandPays: 9.27  },
        image: { influencerGets: 4,  brandPays: 5.14  }
      },
      micro: {
        displayName: 'Micro',
        followerRange: '10k–50k',
        video: { influencerGets: 11, brandPays: 12.36 },
        image: { influencerGets: 6,  brandPays: 7.21  }
      },
      rising: {
        displayName: 'Mid',
        followerRange: '50k–500k',
        video: { influencerGets: 18, brandPays: 19.58 },
        image: { influencerGets: 9,  brandPays: 10.30 }
      },
      established: {
        displayName: 'Macro',
        followerRange: '500k–1m',
        video: { influencerGets: 25, brandPays: 26.79 },
        image: { influencerGets: 12, brandPays: 13.39 }
      },
      premium: {
        displayName: 'Mega',
        followerRange: '1m–5m',
        video: { influencerGets: 33, brandPays: 35.04 },
        image: { influencerGets: 15, brandPays: 16.48 }
      },
      celebrity: {
        displayName: 'Celebrity',
        followerRange: '5m+',
        video: { influencerGets: 45, brandPays: 47.41 },
        image: { influencerGets: 23, brandPays: 24.73 }
      }
    }
  };


  // ================================================================
  //  SECTION 10: NOTIFICATION SYSTEM
  // ================================================================

  var NOTIFICATION_TYPES = {
    submission: { icon: 'upload',    iconClass: 'submission', color: '#2EA5DD' },
    approval:   { icon: 'check',     iconClass: 'approval',  color: '#ED8444' },
    payment:    { icon: 'dollar',    iconClass: 'payment',   color: '#16a34a' },
    joined:     { icon: 'user-plus', iconClass: 'joined',    color: '#707BBB' }
  };

  var NOTIFICATION_RULES = {
    MARK_ALL_READ_AVAILABLE: true,
    FILTER_TABS: ['all', 'unread'],
    BADGE_SHOWS_UNREAD_COUNT: false,   // Red dot only, no number
    MAX_DISPLAY: 50                    // Max notifications in popover
  };


  // ================================================================
  //  SECTION 11: AUTHENTICATION & REGISTRATION
  // ================================================================

  var AUTH_CONFIG = {
    /**
     * Login supports returning user recognition via localStorage.
     * If a brand was previously logged in, shows "Welcome back" state.
     */
    returningUserRecognition: true,
    socialAuth: ['google', 'linkedin'],

    passwordRequirements: {
      minLength: 8,
      requireLowercase: true,
      requireUppercase: true,
      requireNumber: true,
      requireSpecial: true
    },

    /**
     * SSO/SAML only available on Enterprise plan.
     */
    ssoAvailableOn: 'enterprise'
  };


  // ================================================================
  //  SECTION 12: FIELD CONSTRAINTS (Global)
  // ================================================================

  var FIELD_LIMITS = {
    // Rewards
    rewardTitle:       { maxLength: 21 },
    rewardDescription: { maxLength: 85 },
    paymentNote:       { maxLength: 150 },
    purchaseTiers:     { max: 3 },
    gratitudeEvents:   { max: 3 },
    pointInputMin:     0,
    pointInputMax:     99999,

    // Brand Profile
    brandName:         { maxLength: 50 },
    brandDescription:  { maxLength: 300 },
    brandTagline:      { maxLength: 100 },

    // Campaigns
    campaignName:      { maxLength: 60 },
    campaignDesc:      { maxLength: 500 },

    // Images
    rewardImage:       { width: 600, height: 315, format: 'jpg/png' },
    brandLogo:         { width: 400, height: 400, format: 'jpg/png/svg' },
    brandBanner:       { width: 1200, height: 400, format: 'jpg/png' }
  };


  // ================================================================
  //  SECTION 13: NAVIGATION STRUCTURE
  // ================================================================
  // Defines the authenticated app's primary navigation.
  // All inner pages must render this exact nav structure.

  var PRIMARY_NAV = [
    { key: 'activity',    label: 'Activity',         href: 'activity.html' },
    { key: 'campaigns',   label: 'Campaigns',        href: 'campaigns.html' },
    { key: 'content',     label: 'Content',          href: 'content.html' },
    { key: 'influencers', label: 'Influencers',      href: 'influencers.html' },
    { key: 'cash',        label: 'Cash & Rewards',   href: 'cash-rewards.html' }
  ];

  var PROFILE_DROPDOWN = [
    { label: 'Manage Brands',    href: 'manage-brands.html' },
    { label: 'Cash Transactions', href: 'cash-account.html' },
    { label: 'Brand Referral',   href: 'brand-referral.html' },
    { label: 'Pricing',          href: 'pricing-upgrade.html' },
    { label: 'Owners Account',   href: 'owner-account.html' },
    { divider: true },
    { label: 'Help Center',      href: '#' },
    { label: 'Support',          href: '#' },
    { divider: true },
    { label: 'Log Out',          href: '../login.html', className: 'logout' }
  ];


  // ================================================================
  //  SECTION 14: CONTENT OWNERSHIP & RIGHTS
  // ================================================================
  // Content ownership is a CORE part of KUP's value proposition.
  // KUP streamlines the brand-influencer partnership — including rights.
  // This is NOT a neutral marketplace model. KUP actively facilitates
  // content ownership transfer as part of the platform TOS.

  var CONTENT_OWNERSHIP = {

    /**
     * WHO OWNS WHAT — Three parties, clear rights:
     *
     * BRAND:      Owns all content outright once submitted. Full commercial use, forever.
     *             This is the default established in KUP's TOS, written by attorney.
     *
     * KUP:        Non-exclusive license to use submitted content for KUP platform
     *             marketing (case studies, marketplace display, social proof, ads).
     *             This license SURVIVES account deletion — KUP keeps the right
     *             even after brand or influencer leaves the platform.
     *
     * INFLUENCER: Portfolio reference only. Can display thumbnail + "Created for [Brand]"
     *             in their KUP profile to demonstrate their work history.
     *             CANNOT repost, sell, redistribute, or use in another brand's campaign.
     *             The content is NOT theirs — the portfolio is a resume entry, not ownership.
     */

    brandOwnsOnSubmission: true,
    kupMarketingLicense: true,
    kupLicenseSurvivesDeletion: true,
    influencerPortfolioReference: true,
    influencerCanCommerciallyUse: false,

    /**
     * WHEN OWNERSHIP TRANSFERS:
     * The moment content is submitted through the KUP platform, ownership transfers
     * to the brand. This is agreed to by the influencer when they:
     *   1. Create a KUP account (platform-wide TOS)
     *   2. Accept a brand partnership (brand-specific terms)
     *
     * Rejection does NOT release rights back. Brand rejected the quality/fit,
     * not the ownership claim. Brand still owns rejected content.
     */
    ownershipTransferEvent: 'submission',
    rejectionReleasesRights: false,

    /**
     * CONSIDERATION (what makes the ownership transfer legally enforceable):
     * The influencer receives compensation (rewards, cash, product, exposure)
     * in exchange for content. This consideration is required — content
     * cannot be submitted without an active reward attached to the campaign.
     */
    requiresConsideration: true
  };


  // ================================================================
  //  SECTION 15: VIRAL CONTENT BONUS (California Protection)
  // ================================================================
  // Automatic additional compensation when content exceeds performance
  // thresholds. This protects against unconscionable compensation claims
  // (especially in California) where content generates outsized commercial
  // value relative to the base reward.
  //
  // CRITICAL: Thresholds and bonus amounts are PLATFORM-DEFINED.
  // Brands cannot adjust, disable, or cap viral bonuses. This is a
  // platform-level protection for influencers and for KUP's legal position.

  var VIRAL_BONUS = {

    enabled: true,
    brandCanDisable: false,        // Platform-enforced — not optional for brands
    brandCanSetAmounts: false,      // Platform-defined rates only

    /**
     * Performance tiers — evaluated per piece of content, within 30 days
     * of the content being posted/published.
     *
     * NOTE: Actual threshold numbers and bonus amounts are TBD —
     * these will be calibrated with real platform analytics data.
     * The RULE that they exist is locked in now.
     * Placeholder values below for structural reference.
     */
    evaluationWindowDays: 30,

    tiers: {
      standard: {
        label: 'Standard',
        description: 'Content approved — base reward only',
        threshold: null,            // No additional trigger
        bonus: null                 // Base reward is the compensation
      },
      highPerforming: {
        label: 'High Performing',
        description: 'Content exceeds engagement threshold within 30 days',
        threshold: 'TBD',          // e.g., 50K views or 5x avg engagement
        bonus: 'TBD',              // e.g., tier-based multiplier on base reward
        triggerMetric: 'views_or_engagement',
        paidAutomatically: true
      },
      viral: {
        label: 'Viral',
        description: 'Content goes viral — outsized commercial value generated',
        threshold: 'TBD',          // e.g., 500K+ views or 50x avg engagement
        bonus: 'TBD',              // e.g., larger tier-based payout
        triggerMetric: 'views_or_engagement',
        paidAutomatically: true
      }
    },

    /**
     * ENFORCEMENT:
     * - Viral bonuses are paid via the same PayPal Business pipeline as all cash
     * - Brand is charged automatically (added to their next billing cycle)
     * - Influencer is notified when a viral bonus is triggered
     * - If brand's account has insufficient funds, KUP queues and retries
     * - Pending viral bonuses BLOCK account deletion (must be settled first)
     */
    paymentMethod: 'paypal-business',
    chargedToBrand: true,
    pendingBlocksDeletion: true
  };


  // ================================================================
  //  SECTION 16: ACCOUNT DELETION & WIND-DOWN
  // ================================================================
  // Deletion is a controlled process, not a kill switch.
  // Two-sided marketplace obligations must be settled before removal.

  var ACCOUNT_DELETION = {

    /**
     * PHASE 1: Deactivation Request
     * Brand clicks "Delete Account" → enters 30-day wind-down.
     * Account is NOT deleted yet — it's in a deactivation state.
     */
    windDownDays: 30,

    /**
     * PRE-DELETION CHECKLIST (all must be true before wind-down starts):
     * System blocks deletion and shows what needs to be resolved.
     */
    preChecklist: {
      allPaymentsSettled: true,        // No unpaid influencers (including viral bonuses)
      allCampaignsEnded: true,         // No active/paused campaigns — must end them
      noPendingContent: true,          // No "Submitted" content awaiting review — must approve/reject all
      agencyBrandsResolved: true       // Agency plan: all client brands removed or transferred
    },

    /**
     * DURING WIND-DOWN (30 days):
     * - All campaigns auto-pause (no new submissions accepted)
     * - Brand can still log in to settle obligations and export content
     * - Brand can REVERSE deletion (full reactivation) at any time
     * - Content export tools are prominently displayed
     * - Countdown timer shown on dashboard
     */
    duringWindDown: {
      campaignsAutoPause: true,
      brandCanLogin: true,
      brandCanExportContent: true,     // Brand OWNS the content — they should download it
      canReverseDeletion: true,
      newSubmissionsBlocked: true
    },

    /**
     * AFTER WIND-DOWN (soft delete):
     * - Account becomes inaccessible to the brand
     * - Data retained per retention schedule below
     * - KUP marketing license on content SURVIVES (per TOS)
     */
    afterWindDown: 'soft-delete',

    /**
     * DATA RETENTION (post-deletion):
     */
    dataRetention: {
      accountInfo:        { days: 90,   description: 'Email, name, brand info — re-activation window + disputes' },
      paymentHistory:     { days: 2555, description: 'Transaction records — 7 years for tax/legal compliance' },
      contentMetadata:    { days: 90,   description: 'Submission records, approval logs — dispute resolution' },
      contentFiles:       { days: 30,   description: 'Actual images/videos — deleted after wind-down completes' },
      analyticsData:      { days: 90,   description: 'Reporting data — no value without active account' },
      influencerRecords:  { days: -1,   description: 'Partnership history kept on INFLUENCER side permanently (their data)' }
    },

    /**
     * RE-ACTIVATION WINDOWS:
     */
    reactivation: {
      duringWindDown:    { allowed: true,  description: 'Full restore, everything intact' },
      within90Days:      { allowed: true,  description: 'Must re-subscribe. Account data restored, content files may be gone' },
      after90Days:       { allowed: false, description: 'Permanently deleted. Must create new account' }
    },

    /**
     * INFLUENCER IMPACT (when a brand they partner with deletes):
     * - Partnership marked "Brand Inactive" on influencer's side
     * - Influencer retains portfolio references (thumbnail + "Created for [Brand]")
     * - Earned but unredeemed non-cash rewards (points) are FORFEITED
     *   (points have no cash value and brand no longer exists to fulfill)
     * - Any earned but unpaid CASH must be settled during wind-down (pre-checklist)
     * - Influencer is notified when a brand enters deactivation
     */
    influencerImpact: {
      partnershipStatus: 'brand-inactive',
      portfolioRetained: true,
      unredeemedPointsForfeited: true,
      unpaidCashMustSettle: true,
      influencerNotified: true
    }
  };


  // ================================================================
  //  SECTION 17: REFUND POLICY
  // ================================================================

  var REFUND_POLICY = {

    /**
     * KUP is a SaaS subscription. Refunds follow industry standard practices.
     */

    monthly: {
      midCycleCancellation: 'no-refund',
      description: 'Access continues until end of current billing cycle. No pro-rated refund.'
    },

    annual: {
      earlyCancellation: 'no-refund',
      description: 'Access continues until end of paid annual period. No pro-rated refund.'
    },

    firstSignup: {
      gracePeriodDays: 7,
      refund: 'full',
      description: 'Full refund within 7 days of first-ever signup. Goodwill policy, reduces chargebacks.'
    },

    downgrade: {
      method: 'pro-rated-credit',
      description: 'Downgrade (e.g., Agency → Pro) applies pro-rated credit to next billing cycle. No cash refund.'
    },

    deletionDuringActivePeriod: {
      refund: 'no-refund',
      description: 'Access runs until end of paid period. Wind-down starts after paid period expires.'
    },

    /**
     * CHARGEBACK PROTECTION:
     * - 7-day grace period reduces first-signup chargebacks
     * - Content export during wind-down proves brand received value
     * - TOS explicitly states no pro-rated refunds after grace period
     * - Payment records retained 7 years for dispute evidence
     */
    chargebackProtection: true
  };


  // ================================================================
  //  SECTION 18: PARTNERSHIP RATING SYSTEM
  // ================================================================
  // Uber-style mutual rating between brands and influencers.
  // Triggered after every content approval (the "transaction").
  // Both sides rate each other on role-specific criteria.
  // Aggregate scores visible on profiles — individual ratings anonymous.

  var RATING_SYSTEM = {

    /**
     * WHEN RATINGS TRIGGER:
     * A rating prompt appears for BOTH parties after content is approved.
     * Content approval = the "transaction complete" moment (like end of Uber ride).
     * Rating window stays open for 7 days after approval. After that, it expires.
     * Expired ratings do NOT count against either party.
     */
    triggerEvent: 'content-approved',
    ratingWindowDays: 7,
    expiredRatingEffect: 'none',     // No penalty for not rating

    /**
     * SCALE: 1-5 stars (whole numbers only, no half-stars)
     */
    scale: { min: 1, max: 5, step: 1, type: 'stars' },

    /**
     * MANDATORY VS OPTIONAL:
     * Rating is OPTIONAL but PROMPTED. Both parties see a prompt
     * after content approval. They can dismiss it, but the prompt
     * reappears on next login until the window expires.
     * Why optional: Forced ratings produce garbage data.
     * Why prompted: Unprompted ratings have < 5% participation.
     */
    required: false,
    prompted: true,
    promptPersists: true,            // Re-shows on next login until rated or expired

    /**
     * ANONYMITY:
     * Individual ratings are ANONYMOUS. Neither party sees who rated them what.
     * Only the AGGREGATE score is visible on profiles.
     * Why: Prevents retaliation ratings and encourages honest feedback.
     * The exception: Optional text feedback IS visible to the rated party
     * (but not attributed to a specific rater if multiple ratings exist).
     */
    individualRatingsAnonymous: true,
    aggregateVisible: true,

    /**
     * BRAND RATES INFLUENCER — 4 criteria
     * These reflect what matters to brands when working with influencers.
     */
    brandRatesInfluencer: {
      criteria: [
        {
          key: 'content-quality',
          label: 'Content Quality',
          description: 'Quality of the delivered content (creativity, production value, on-brand)',
          weight: 1
        },
        {
          key: 'timeliness',
          label: 'Timeliness',
          description: 'Met deadlines and delivered within expected timeframe',
          weight: 1
        },
        {
          key: 'communication',
          label: 'Communication',
          description: 'Responsive, professional, easy to work with',
          weight: 1
        },
        {
          key: 'brief-compliance',
          label: 'Brief Compliance',
          description: 'Followed the campaign brief, guidelines, and requirements',
          weight: 1
        }
      ],
      optionalTextFeedback: true,
      textFeedbackMaxLength: 300
    },

    /**
     * INFLUENCER RATES BRAND — 4 criteria
     * These reflect what matters to influencers when partnering with brands.
     */
    influencerRatesBrand: {
      criteria: [
        {
          key: 'communication',
          label: 'Communication',
          description: 'Clear expectations, responsive to questions, professional interactions',
          weight: 1
        },
        {
          key: 'reward-fulfillment',
          label: 'Reward Fulfillment',
          description: 'Delivered promised rewards on time (product shipped, cash paid, points awarded)',
          weight: 1
        },
        {
          key: 'brief-clarity',
          label: 'Brief Clarity',
          description: 'Campaign brief was clear, detailed, and reasonable',
          weight: 1
        },
        {
          key: 'professionalism',
          label: 'Professionalism',
          description: 'Respectful, fair feedback on submissions, good to work with',
          weight: 1
        }
      ],
      optionalTextFeedback: true,
      textFeedbackMaxLength: 300
    },

    /**
     * AGGREGATE SCORE CALCULATION:
     * Simple average of all criteria per rating, then average of all ratings.
     * Displayed as X.X / 5.0 on profiles with star visualization.
     * Minimum 3 ratings before aggregate is shown publicly
     * (prevents one bad rating from tanking a new profile).
     */
    aggregateCalculation: 'simple-average',
    minRatingsToDisplay: 3,
    displayFormat: 'X.X / 5.0',

    /**
     * PROFILE DISPLAY:
     * Aggregate score shown on:
     * - Influencer profile card (visible to brands in Discovery, My Influencers)
     * - Brand profile (visible to influencers when evaluating partnerships)
     * Before minRatingsToDisplay is reached, shows "New" badge instead of stars.
     */
    displayLocations: {
      influencerCard: true,            // Discovery tab, My Influencers list
      influencerProfile: true,         // Full influencer profile view
      brandProfile: true,              // Brand profile visible to influencers
      partnershipRequest: true         // Shown when evaluating partnership requests
    },

    /**
     * CONSEQUENCES OF LOW RATINGS:
     * Low ratings trigger FLAGS, not auto-removal.
     * KUP keeps humans in the loop — no algorithmic punishment.
     *
     * Thresholds:
     * - Below 3.0 average (after 5+ ratings): "Needs Improvement" flag
     * - Below 2.0 average (after 10+ ratings): "At Risk" flag → KUP review
     *
     * What flags do:
     * - Warning icon on profile (visible to potential partners)
     * - Notification to the flagged party with suggestions for improvement
     * - "At Risk" triggers manual KUP platform team review
     *
     * What flags do NOT do:
     * - Auto-suspend or auto-remove accounts
     * - Hide profiles from Discovery
     * - Block existing partnerships
     * - Affect cash payout rates (those are tier-based, period)
     */
    consequences: {
      needsImprovement: {
        threshold: 3.0,
        minRatings: 5,
        label: 'Needs Improvement',
        icon: '⚠️',
        action: 'warning-badge-on-profile'
      },
      atRisk: {
        threshold: 2.0,
        minRatings: 10,
        label: 'At Risk',
        icon: '🚩',
        action: 'manual-review'           // KUP team reviews, no auto-action
      }
    },

    /**
     * ANTI-GAMING RULES:
     * - One rating per party per content approval (no duplicate ratings)
     * - Cannot edit a submitted rating (prevents pressure-based changes)
     * - Ratings persist even after partnership ends (historical record)
     * - Brands/influencers cannot see WHO rated them (anonymous)
     * - Platform team can remove fraudulent ratings upon review
     */
    antiGaming: {
      oneRatingPerApproval: true,
      ratingsEditable: false,
      ratingsPersistAfterPartnershipEnds: true,
      platformCanRemoveFraudulent: true
    }
  };


  // ================================================================
  //  SECTION 20: BRAND REFERRAL PROGRAM
  // ================================================================
  // Brands refer other brands to KUP. Grows demand side of marketplace.
  // Referral reward = account credit, free month, or cash (plan-dependent).
  // Tracks referral funnel: shared → signed-up → activated paid plan → rewarded.

  var BRAND_REFERRAL = {

    /**
     * Program toggle — can be disabled globally.
     */
    enabled: true,

    /**
     * Referral link format.
     * Each brand gets a unique referral code appended to the KUP signup URL.
     * Format: https://keepuspostd.com/signup?ref={BRAND_REFERRAL_CODE}
     */
    linkFormat: 'https://keepuspostd.com/signup?ref={code}',

    /**
     * Qualification trigger.
     * Referred brand must complete ALL of these before the referrer earns reward:
     * 1. Sign up using referral link
     * 2. Activate a PAID plan (Starter, Growth, Pro, or Agency)
     * 3. Remain on paid plan for at least 30 days (fraud guard)
     */
    qualificationTrigger: 'paid_plan_activation',
    qualificationHoldDays: 30,

    /**
     * Reward tiers by referrer's plan.
     * Higher plans get better referral rewards (creates upsell incentive).
     */
    rewards: {
      starter: {
        referrerReward: { type: 'account_credit', amount: 25, currency: 'USD' },
        referredReward: null,
        label: '$25 account credit'
      },
      growth: {
        referrerReward: { type: 'account_credit', amount: 50, currency: 'USD' },
        referredReward: { type: 'discount', percent: 10, durationMonths: 3 },
        label: '$50 credit + referred gets 10% off 3 months'
      },
      pro: {
        referrerReward: { type: 'account_credit', amount: 75, currency: 'USD' },
        referredReward: { type: 'discount', percent: 10, durationMonths: 3 },
        label: '$75 credit + referred gets 10% off 3 months'
      },
      agency: {
        referrerReward: { type: 'account_credit', amount: 100, currency: 'USD' },
        referredReward: { type: 'discount', percent: 15, durationMonths: 3 },
        label: '$100 credit + referred gets 15% off 3 months'
      }
    },

    /**
     * Monthly cap — prevents abuse.
     * Max referrals rewarded per calendar month.
     */
    caps: {
      starter: 3,
      growth: 5,
      pro: 10,
      agency: 25
    },

    /**
     * Share channels available in UI.
     */
    shareChannels: ['copy_link', 'email', 'linkedin', 'twitter'],

    /**
     * Referral statuses for tracking table.
     */
    statuses: {
      PENDING: { label: 'Signed Up', color: '#f59e0b', description: 'Referred brand created an account' },
      ACTIVATED: { label: 'Plan Activated', color: '#2EA5DD', description: 'Referred brand activated a paid plan' },
      QUALIFIED: { label: 'Qualified', color: '#22c55e', description: 'Passed 30-day hold period' },
      REWARDED: { label: 'Rewarded', color: '#22c55e', description: 'Credit applied to referrer account' },
      EXPIRED: { label: 'Expired', color: '#999', description: 'Referred brand did not activate within 90 days' }
    },

    /**
     * Expiration window.
     * If referred brand doesn't activate paid plan within 90 days, referral expires.
     */
    expirationDays: 90,

    /**
     * Anti-fraud rules.
     */
    fraud: {
      selfReferralBlocked: true,
      samePaymentMethodBlocked: true,
      minPaidDaysBeforeReward: 30,
      duplicateEmailBlocked: true
    }
  };


  // ================================================================
  //  SECTION 21: ACCOUNT-LEVEL BILLING ARCHITECTURE
  // ================================================================
  // The KUP billing model is ACCOUNT-LEVEL, not brand-level.
  // One account = one PayPal subscription = one plan tier.
  // All brands under the account share the same plan's features and limits.

  var ACCOUNT_BILLING = {

    // ACCOUNT HIERARCHY
    hierarchy: {
      root: 'account',
      children: 'brands',
      billingEntity: 'account',
      planScope: 'account'
    },

    // ANCHOR BRAND — first brand created, cannot be deleted
    anchorBrand: {
      isFirstBrand: true,
      canBeDeleted: false,
      canBeTransferred: false,
      canBePaused: true,
      canBeArchived: true
    },

    // BRAND LIFECYCLE STATES
    brandStates: {
      active: {
        label: 'Active',
        color: '#16a34a',
        description: 'Fully operational — campaigns, content, influencers all active',
        canCreateCampaigns: true,
        canReceiveContent: true,
        countsTowardLimit: true
      },
      paused: {
        label: 'Paused',
        color: '#f59e0b',
        description: 'Temporarily frozen — data preserved, no new activity',
        canCreateCampaigns: false,
        canReceiveContent: false,
        countsTowardLimit: true
      },
      archived: {
        label: 'Archived',
        color: '#888888',
        description: 'Long-term storage — read-only, does NOT count toward plan limit',
        canCreateCampaigns: false,
        canReceiveContent: false,
        countsTowardLimit: false
      },
      scheduledForDeletion: {
        label: 'Scheduled for Deletion',
        color: '#dc2626',
        description: 'Permanently deleted after 30-day wind-down',
        canCreateCampaigns: false,
        canReceiveContent: false,
        countsTowardLimit: false,
        windDownDays: 30
      }
    },

    // STATE TRANSITIONS
    brandTransitions: {
      active: ['paused', 'archived', 'scheduledForDeletion'],
      paused: ['active', 'archived', 'scheduledForDeletion'],
      archived: ['active', 'scheduledForDeletion'],
      scheduledForDeletion: ['active']
    },

    // RESOURCE ALLOCATION
    resourceAllocation: {
      influencerPool: 'shared',
      postdPayBudget: 'per-brand',
      campaignLimit: 'per-brand',
      storage: 'shared',
      adminSeats: 'shared'
    },

    // BILLING RULES
    billingRules: {
      subscriptionModel: 'single-per-account',
      processor: 'paypal-business',
      perBrandBilling: false,
      perBrandAddons: false,
      allBrandsShareTier: true
    },

    // PLAN DOWNGRADE RULES
    downgradeRules: {
      mustFitNewBrandLimit: true,
      archivedBrandsExempt: true,
      pausedBrandsCount: true,
      blockedIfOverLimit: true,
      userAction: 'Must pause/archive/delete brands to fit new plan limit'
    },

    // PAYMENT FAILURE CASCADE
    paymentFailureCascade: {
      gracePeriodDays: 7,
      gracePeriodAction: 'banner-warning',
      afterGrace: {
        anchorBrandStatus: 'active',
        otherBrandsStatus: 'paused',
        notification: 'email-to-owner'
      },
      suspensionDays: 30,
      suspensionAction: {
        anchorBrandStatus: 'paused',
        accountMode: 'read-only',
        campaignsAutoPause: true
      },
      deletionTriggerDays: 60
    }
  };


  // ================================================================
  //  SECTION 19: PLATFORM-WIDE RULES (GLOBAL HARD CONSTRAINTS)
  // ================================================================

  var GLOBAL_RULES = {

    /**
     * RULE G1: Brand isolation
     * Every data entity (campaign, reward, influencer partnership, content)
     * is scoped to a single brand. No cross-brand data leakage.
     */
    BRAND_ISOLATION: true,

    /**
     * RULE G2: Owner is singular
     * Exactly 1 owner per brand account. Transfer is the only way to change.
     * Owner cannot be removed — only transferred to an Admin.
     */
    ONE_OWNER_PER_BRAND: true,

    /**
     * RULE G3: Deletion requires confirmation
     * No destructive action (delete campaign, remove influencer, remove reward)
     * can happen without explicit user confirmation (modal or toast confirm).
     */
    DELETION_REQUIRES_CONFIRMATION: true,

    /**
     * RULE G4: Draft-only deletion
     * Campaigns can only be deleted in Draft status.
     * Active/paused must be ended first, then retained for data integrity.
     */
    ONLY_DRAFTS_DELETABLE: true,

    /**
     * RULE G5: All payments via PayPal Business
     * No Stripe, no direct bank transfer. PayPal Business is the sole processor.
     * Influencers receive funds to their PayPal Business accounts.
     */
    PAYMENT_PROCESSOR: 'paypal-business',

    /**
     * RULE G6: Content approval is required
     * No content goes live without brand (or authorized role) approval.
     * Even with auto-approval settings, the system records who approved.
     */
    CONTENT_REQUIRES_APPROVAL: true,

    /**
     * RULE G7: Influencer tier determines cash rates
     * No brand can override tier-based cash rates for CPA/Bonus.
     * This prevents a race to the bottom and ensures platform fairness.
     */
    TIER_BASED_CASH_ONLY: true,

    /**
     * RULE G8: Agency features require Agency plan
     * Access levels, shield mode, multi-brand management, white-label —
     * all Agency plan exclusive. Lower plans see standard brand management.
     */
    AGENCY_FEATURES_REQUIRE_AGENCY_PLAN: true,

    /**
     * RULE G9: Plan limits are hard-enforced
     * Hitting a limit (brands, campaigns, influencers, seats) blocks creation.
     * System shows upgrade prompt — never silently allows overages.
     */
    PLAN_LIMITS_ARE_HARD: true,

    /**
     * RULE G10: No account creation by proxy
     * Brands cannot create influencer accounts. Influencers self-register.
     * Brands can only INVITE (email/handle) — the influencer completes signup.
     */
    NO_PROXY_ACCOUNT_CREATION: true
  };


  // ================================================================
  //  22. BRAND CATEGORIES
  // ================================================================
  //  Centralized list of industry categories for brand onboarding,
  //  add-brand, and influencer discovery filters.
  //  Alphabetical order. "Other" always last.

  var BRAND_CATEGORIES = [
    'Arts & Creative',
    'Automotive',
    'Cannabis & CBD',
    'Education',
    'Entertainment',
    'Fashion & Beauty',
    'Finance',
    'Food & Beverage',
    'Gaming & Esports',
    'Health & Fitness',
    'Home & Garden',
    'Hospitality & Restaurant',
    'Legal & Professional Services',
    'Media & Publishing',
    'Music & Audio',
    'Nonprofit & Cause',
    'Parenting & Family',
    'Pet & Animal',
    'Real Estate',
    'Retail & E-commerce',
    'Sports & Outdoors',
    'Sustainability & Eco',
    'Technology & SaaS',
    'Travel & Lifestyle',
    'Other'
  ];


  // ================================================================
  //  PUBLIC API
  // ================================================================

  return {
    // Design
    DESIGN: DESIGN,

    // Pricing & Gating
    PRICING_TIERS: PRICING_TIERS,
    TRIAL: TRIAL,
    canAccess: canAccess,
    getPlanLimit: getPlanLimit,

    // Admin Roles
    ADMIN_ROLES: ADMIN_ROLES,
    hasPermission: hasPermission,

    // Agency
    AGENCY_ACCESS_LEVELS: AGENCY_ACCESS_LEVELS,
    AGENCY_SHIELD: AGENCY_SHIELD,

    // Content
    CONTENT_STATUSES: CONTENT_STATUSES,
    CONTENT_TRANSITIONS: CONTENT_TRANSITIONS,
    CONTENT_RULES: CONTENT_RULES,

    // Campaigns
    CAMPAIGN_STATUSES: CAMPAIGN_STATUSES,
    CAMPAIGN_TRANSITIONS: CAMPAIGN_TRANSITIONS,
    CAMPAIGN_RULES: CAMPAIGN_RULES,

    // Influencers
    INFLUENCER_TABS: INFLUENCER_TABS,
    INFLUENCE_TIERS: INFLUENCE_TIERS,
    INFLUENCER_RULES: INFLUENCER_RULES,
    DISCOVERY_TIERS: DISCOVERY_TIERS,

    // Rewards
    REWARD_TYPES: REWARD_TYPES,
    EARNING_METHODS: EARNING_METHODS,
    REWARD_RULES: REWARD_RULES,
    POINT_CATEGORIES: POINT_CATEGORIES,
    POINT_RULES: POINT_RULES,
    getWizardSteps: getWizardSteps,
    showsEarningStep: showsEarningStep,
    needsPointConfig: needsPointConfig,
    isCashType: isCashType,

    // Payments
    PAYMENT_CONFIG: PAYMENT_CONFIG,

    // Notifications
    NOTIFICATION_TYPES: NOTIFICATION_TYPES,
    NOTIFICATION_RULES: NOTIFICATION_RULES,

    // Auth
    AUTH_CONFIG: AUTH_CONFIG,

    // Fields
    FIELD_LIMITS: FIELD_LIMITS,

    // Navigation
    PRIMARY_NAV: PRIMARY_NAV,
    PROFILE_DROPDOWN: PROFILE_DROPDOWN,

    // Content Ownership
    CONTENT_OWNERSHIP: CONTENT_OWNERSHIP,

    // Viral Bonus
    VIRAL_BONUS: VIRAL_BONUS,

    // Account Deletion
    ACCOUNT_DELETION: ACCOUNT_DELETION,

    // Refund Policy
    REFUND_POLICY: REFUND_POLICY,

    // Rating System
    RATING_SYSTEM: RATING_SYSTEM,

    // Brand Referral Program
    BRAND_REFERRAL: BRAND_REFERRAL,

    // Account-Level Billing
    ACCOUNT_BILLING: ACCOUNT_BILLING,

    // Brand Categories
    BRAND_CATEGORIES: BRAND_CATEGORIES,

    // Global Rules
    GLOBAL_RULES: GLOBAL_RULES
  };

})();
