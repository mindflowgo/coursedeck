import { describe, expect, it } from 'bun:test';
import { groupItemsByGroups } from './groupUtils';

interface TestItem {
  id: string;
  title: string;
  group?: string;
}

describe('groupItemsByGroups', () => {
  it('returns empty array when items array is empty', () => {
    const buckets = groupItemsByGroups([], (x: TestItem) => x.group, (x) => x.id, ['Group A']);
    expect(buckets).toEqual([]);
  });

  it('returns a single unnamed bucket when no configured groups and no items have groups', () => {
    const items: TestItem[] = [
      { id: '1', title: 'Course 1' },
      { id: '2', title: 'Course 2' }
    ];
    const buckets = groupItemsByGroups(items, (x) => x.group, (x) => x.id, []);
    expect(buckets.length).toBe(1);
    expect(buckets[0].id).toBe('__all__');
    expect(buckets[0].name).toBe('');
    expect(buckets[0].items).toEqual(items);
    expect(buckets[0].isUngrouped).toBe(true);
  });

  it('groups items into configured groups in order, extra groups, and ungrouped', () => {
    const items: TestItem[] = [
      { id: 'c1', title: 'Math 101', group: 'Mathematics' },
      { id: 'c2', title: 'Physics 101', group: 'Science' },
      { id: 'c3', title: 'History 101', group: 'Humanities' }, // not in configured
      { id: 'c4', title: 'Calculus', group: 'mathematics' }, // case-insensitive match
      { id: 'c5', title: 'Unassigned 1' }
    ];

    const configured = ['Science', 'Mathematics', 'Empty Group'];
    const buckets = groupItemsByGroups(items, (x) => x.group, (x) => x.id, configured);

    // Expect 4 buckets: Science, Mathematics, Humanities (extra), Ungrouped
    // 'Empty Group' is omitted because it has no items
    expect(buckets.map((b) => b.name)).toEqual(['Science', 'Mathematics', 'Humanities', 'Ungrouped']);

    expect(buckets[0].items.map((i) => i.id)).toEqual(['c2']);
    expect(buckets[1].items.map((i) => i.id)).toEqual(['c1', 'c4']);
    expect(buckets[2].items.map((i) => i.id)).toEqual(['c3']);
    expect(buckets[3].items.map((i) => i.id)).toEqual(['c5']);
    expect(buckets[3].isUngrouped).toBe(true);
  });

  it('handles configured groups that are all empty by not showing Ungrouped header', () => {
    const items: TestItem[] = [
      { id: 'c1', title: 'Course 1' },
      { id: 'c2', title: 'Course 2' }
    ];
    const configured = ['Group A', 'Group B'];
    const buckets = groupItemsByGroups(items, (x) => x.group, (x) => x.id, configured);

    expect(buckets.length).toBe(1);
    expect(buckets[0].id).toBe('__ungrouped__');
    expect(buckets[0].name).toBe('');
    expect(buckets[0].items).toEqual(items);
  });
});
