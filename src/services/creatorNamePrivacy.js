// Name privacy for campaign brands whose videos are real people's personal
// stories. For brands listed here, API responses show "First L." instead of
// the creator's full display name. Every other brand is unchanged.
const PRIVATE_NAME_BRANDS = new Set(['risewithwells']);

function isPrivateNameBrand(brandHandle) {
  return PRIVATE_NAME_BRANDS.has(String(brandHandle || '').toLowerCase());
}

// "Katrina Glenn" -> "Katrina G."  "Cher" -> "Cher"  "" -> "Creator"
function shortCreatorName(name) {
  const parts = String(name || '').replace(/<[^>]*>/g, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Creator';
  if (parts.length === 1) return parts[0];
  const initial = (parts[parts.length - 1].match(/\p{L}/u) || [''])[0].toUpperCase();
  return initial ? `${parts[0]} ${initial}.` : parts[0];
}

module.exports = { isPrivateNameBrand, shortCreatorName };
