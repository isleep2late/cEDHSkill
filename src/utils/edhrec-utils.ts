// utils/edhrec-utils.ts - Commander validation against EDHREC

/**
 * Normalize commander name for database storage and URL formatting
 */
export function normalizeCommanderName(name: string): string {
  return name.toLowerCase()
    .replace(/[^\w\s-]/g, '') // Remove special characters except hyphens
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Validate commander name against EDHREC database
 */
export async function validateCommander(commanderName: string): Promise<boolean> {
  try {
    const normalizedName = normalizeCommanderName(commanderName);
    
    // EDHREC URL format: https://edhrec.com/commanders/commander-name
    const edhrecUrl = `https://edhrec.com/commanders/${normalizedName}`;
    
    // Make request to EDHREC
    const response = await fetch(edhrecUrl, {
      method: 'HEAD', // Use HEAD to just check if page exists
      headers: {
        'User-Agent': 'cEDHSkill Bot/1.0'
      }
    });
    
    // If we get a 200 response, the commander exists
    // EDHREC returns 404 for non-existent commanders
    return response.status === 200;
    
  } catch (error) {
    console.error(`Error validating commander ${commanderName}:`, error);
    
    // If there's a network error or other issue, we'll be lenient
    // and allow the commander name to pass validation
    // This prevents the bot from breaking due to network issues
    console.warn(`EDHREC validation failed for ${commanderName}, allowing anyway`);
    return true;
  }
}

/**
 * Get EDHREC URL for a commander
 */
export function getEdhrecUrl(commanderName: string): string {
  const normalizedName = normalizeCommanderName(commanderName);
  return `https://edhrec.com/commanders/${normalizedName}`;
}

/**
 * Format commander name for display (capitalizes words)
 */
export function formatCommanderName(name: string): string {
  return name
    .split(/[-\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Batch validate multiple commanders
 */
export async function validateCommanders(commanderNames: string[]): Promise<{ [key: string]: boolean }> {
  const results: { [key: string]: boolean } = {};
  
  // Validate commanders in parallel for better performance
  const validationPromises = commanderNames.map(async (name) => {
    const isValid = await validateCommander(name);
    results[name] = isValid;
    return { name, isValid };
  });
  
  await Promise.all(validationPromises);
  return results;
}

/**
 * Search for similar commander names (for typo suggestions)
 */
export async function findSimilarCommanders(searchTerm: string, maxResults: number = 5): Promise<string[]> {
  try {
    // This would require a more sophisticated implementation
    // For now, we'll return an empty array
    // In the future, this could use EDHREC's search API or a local commander database
    return [];
  } catch (error) {
    console.error('Error finding similar commanders:', error);
    return [];
  }
}

/**
 * Cache for recently validated commanders to reduce API calls
 */
const validationCache = new Map<string, { valid: boolean; timestamp: number }>();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Validate commander with caching to reduce API calls
 */
export async function validateCommanderCached(commanderName: string): Promise<boolean> {
  const normalizedName = normalizeCommanderName(commanderName);
  const now = Date.now();
  
  // Check cache first
  const cached = validationCache.get(normalizedName);
  if (cached && (now - cached.timestamp) < CACHE_DURATION) {
    return cached.valid;
  }
  
  // Validate and cache result
  const isValid = await validateCommander(commanderName);
  validationCache.set(normalizedName, { valid: isValid, timestamp: now });
  
  // Clean up old cache entries periodically
  if (validationCache.size > 1000) {
    for (const [key, value] of validationCache.entries()) {
      if ((now - value.timestamp) > CACHE_DURATION) {
        validationCache.delete(key);
      }
    }
  }
  
  return isValid;
}