export interface GroupBucket<T> {
  id: string;
  name: string;
  items: T[];
  isUngrouped?: boolean;
}

/**
 * Groups an array of items by configured group names, extra groups found on items,
 * and an optional 'Ungrouped' bucket for the remainder.
 *
 * If no items are grouped and no configured groups exist, returns a single bucket with name = ''.
 */
export function groupItemsByGroups<T>(
  items: T[],
  getGroup: (item: T) => string | undefined,
  getId: (item: T) => string,
  configuredGroups: string[] = []
): GroupBucket<T>[] {
  if (items.length === 0) return [];

  const hasAnyGrouped = items.some((item) => {
    const g = getGroup(item);
    return Boolean(g && g.trim());
  });

  // If no configured groups and no items have groups, return single bucket with no name
  if (configuredGroups.length === 0 && !hasAnyGrouped) {
    return [
      {
        id: '__all__',
        name: '',
        items,
        isUngrouped: true
      }
    ];
  }

  const buckets: GroupBucket<T>[] = [];
  const seenIds = new Set<string>();

  // 1. Configured groups in their defined order
  for (const groupName of configuredGroups) {
    const trimmed = groupName.trim();
    if (!trimmed) continue;
    const matching = items.filter((item) => {
      const g = getGroup(item);
      return g && g.trim().toLowerCase() === trimmed.toLowerCase();
    });
    if (matching.length > 0) {
      buckets.push({
        id: trimmed,
        name: trimmed,
        items: matching
      });
      matching.forEach((item) => seenIds.add(getId(item)));
    }
  }

  // 2. Extra groups present on items (not in configured groups)
  for (const item of items) {
    const g = getGroup(item);
    const id = getId(item);
    if (g && g.trim() && !seenIds.has(id)) {
      const gName = g.trim();
      const existing = buckets.find((b) => b.name.toLowerCase() === gName.toLowerCase());
      if (existing) {
        existing.items.push(item);
      } else {
        buckets.push({
          id: gName,
          name: gName,
          items: [item]
        });
      }
      seenIds.add(id);
    }
  }

  // 3. Ungrouped items
  const ungrouped = items.filter((item) => !seenIds.has(getId(item)));
  if (ungrouped.length > 0) {
    buckets.push({
      id: '__ungrouped__',
      name: buckets.length > 0 ? 'Ungrouped' : '',
      items: ungrouped,
      isUngrouped: true
    });
  }

  return buckets;
}
