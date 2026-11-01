import fs from 'node:fs';
import path from 'node:path';
import type { CourseManifest } from '../../parser/courseIngest';
import { CourseService } from '../courses';
import { LibraryService } from '../library';
import { getGroupsPath, loadAppSettings } from '../paths';

export interface GroupItem {
  id: string;
  name: string;
  type: 'course' | 'library' | string;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `group-${Date.now().toString(36)}`
  );
}

export class GroupService {
  /**
   * Reads all groups from data/groups.json.
   * Auto-migrates from settings or course manifests on disk if not yet present.
   */
  static getAllGroups(): GroupItem[] {
    const groupsPath = getGroupsPath();
    let items: GroupItem[] = [];

    if (fs.existsSync(groupsPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
        if (Array.isArray(raw)) {
          items = raw
            .filter((item) => item && typeof item === 'object' && typeof item.name === 'string')
            .map((item) => ({
              id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : slugify(item.name),
              name: String(item.name).trim(),
              type: typeof item.type === 'string' && item.type.trim() ? item.type.trim() : 'course'
            }));
        }
      } catch (e) {
        console.warn('Failed to parse groups.json:', e);
      }
    } else {
      // Migrate from AppSettings or existing courses on disk if groups.json not yet written
      const settings = loadAppSettings();
      const initialCourseGroups: string[] = Array.isArray(settings.groups?.course)
        ? settings.groups.course
        : Array.isArray(settings.course_groups)
          ? settings.course_groups
          : [];

      for (const g of initialCourseGroups) {
        if (g && typeof g === 'string' && g.trim()) {
          const name = g.trim();
          if (!items.some((it) => it.type === 'course' && it.name.toLowerCase() === name.toLowerCase())) {
            items.push({ id: slugify(name), name, type: 'course' });
          }
        }
      }

      if (settings.groups && typeof settings.groups === 'object') {
        for (const [type, groupList] of Object.entries(settings.groups)) {
          if (type !== 'course' && Array.isArray(groupList)) {
            for (const g of groupList) {
              if (g && typeof g === 'string' && g.trim()) {
                const name = g.trim();
                items.push({ id: slugify(name), name, type });
              }
            }
          }
        }
      }
    }

    // Always discover any groups stored in course manifests on disk
    const courses = CourseService.listCourses();
    let hasNewDiscovered = false;
    for (const c of courses) {
      if (c.group && c.group.trim()) {
        const name = c.group.trim();
        if (!items.some((it) => it.type === 'course' && it.name.toLowerCase() === name.toLowerCase())) {
          items.push({ id: slugify(name), name, type: 'course' });
          hasNewDiscovered = true;
        }
      }
    }

    // Always discover any groups stored in library manifest on disk
    try {
      const libManifest = LibraryService.loadManifest();
      for (const d of libManifest.documents) {
        if (d.group && d.group.trim()) {
          const name = d.group.trim();
          if (!items.some((it) => it.type === 'library' && it.name.toLowerCase() === name.toLowerCase())) {
            items.push({ id: slugify(name), name, type: 'library' });
            hasNewDiscovered = true;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to discover groups from library manifest:', e);
    }

    if (!fs.existsSync(groupsPath) || hasNewDiscovered) {
      this.writeGroupsFile(items);
    }

    return items;
  }

  private static writeGroupsFile(items: GroupItem[]): void {
    const groupsPath = getGroupsPath();
    try {
      fs.mkdirSync(path.dirname(groupsPath), { recursive: true });
      fs.writeFileSync(groupsPath, JSON.stringify(items, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to write groups.json:', e);
    }
  }

  static getGroups(type?: string): GroupItem[] {
    const all = this.getAllGroups();
    if (!type) return all;
    return all.filter((g) => g.type.toLowerCase() === type.toLowerCase().trim());
  }

  static addGroup(type: string, name: string): { group: GroupItem; groups: GroupItem[] } {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Group name cannot be empty');
    const cleanType = type.toLowerCase().trim();

    const all = this.getAllGroups();
    const existing = all.find(
      (g) => g.type.toLowerCase() === cleanType && g.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (existing) {
      return { group: existing, groups: all };
    }

    const newItem: GroupItem = {
      id: slugify(trimmed),
      name: trimmed,
      type: cleanType
    };
    all.push(newItem);
    this.writeGroupsFile(all);
    return { group: newItem, groups: all };
  }

  static renameGroup(
    type: string,
    oldName: string,
    newName: string
  ): { groups: GroupItem[]; updatedCount: number } {
    const trimmedOld = oldName.trim();
    const trimmedNew = newName.trim();
    if (!trimmedOld || !trimmedNew) {
      throw new Error('Both oldName and newName are required');
    }
    const cleanType = type.toLowerCase().trim();

    const all = this.getAllGroups();
    const target = all.find(
      (g) => g.type.toLowerCase() === cleanType && g.name.toLowerCase() === trimmedOld.toLowerCase()
    );

    if (target) {
      target.name = trimmedNew;
    } else {
      all.push({
        id: slugify(trimmedNew),
        name: trimmedNew,
        type: cleanType
      });
    }

    this.writeGroupsFile(all);

    let updatedCount = 0;
    if (cleanType === 'course') {
      updatedCount = this.renameCourseGroupOnDisk(trimmedOld, trimmedNew);
    } else if (cleanType === 'library') {
      updatedCount = this.renameLibraryGroupOnDisk(trimmedOld, trimmedNew);
    }
    return { groups: all, updatedCount };
  }

  static deleteGroup(
    type: string,
    name: string,
    clearEntities = true
  ): { groups: GroupItem[]; updatedCount: number } {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Group name cannot be empty');
    const cleanType = type.toLowerCase().trim();

    let all = this.getAllGroups();
    all = all.filter(
      (g) => !(g.type.toLowerCase() === cleanType && g.name.toLowerCase() === trimmed.toLowerCase())
    );
    this.writeGroupsFile(all);

    let updatedCount = 0;
    if (clearEntities) {
      if (cleanType === 'course') {
        updatedCount = this.deleteCourseGroupOnDisk(trimmed);
      } else if (cleanType === 'library') {
        updatedCount = this.deleteLibraryGroupOnDisk(trimmed);
      }
    }
    return { groups: all, updatedCount };
  }

  static reorderGroups(type: string, groupNames: string[]): GroupItem[] {
    const cleanType = type.toLowerCase().trim();
    const all = this.getAllGroups();
    const otherGroups = all.filter((g) => g.type.toLowerCase() !== cleanType);
    const typeGroups = all.filter((g) => g.type.toLowerCase() === cleanType);

    const reordered: GroupItem[] = [];
    for (const name of groupNames) {
      const match = typeGroups.find((g) => g.name.toLowerCase() === name.toLowerCase().trim());
      if (match && !reordered.some((r) => r.id === match.id)) {
        reordered.push(match);
      }
    }
    // Append any remaining of that type
    for (const g of typeGroups) {
      if (!reordered.some((r) => r.id === g.id)) {
        reordered.push(g);
      }
    }

    const finalAll = [...otherGroups, ...reordered];
    this.writeGroupsFile(finalAll);
    return finalAll;
  }

  private static renameCourseGroupOnDisk(oldName: string, newName: string): number {
    const coursesDir = CourseService.getCoursesDir();
    if (!fs.existsSync(coursesDir)) return 0;

    let updatedCount = 0;
    const dirs = fs
      .readdirSync(coursesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);

    for (const dir of dirs) {
      const courseFolder = path.join(coursesDir, dir);
      const manifestPath = path.join(courseFolder, '.manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest: CourseManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest.group && manifest.group.trim() === oldName) {
            manifest.group = newName;
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
            updatedCount++;
          }
        } catch (e) {
          console.error(`Failed to update group for ${dir}:`, e);
        }
      }
    }
    return updatedCount;
  }

  private static deleteCourseGroupOnDisk(groupName: string): number {
    const coursesDir = CourseService.getCoursesDir();
    if (!fs.existsSync(coursesDir)) return 0;

    let updatedCount = 0;
    const dirs = fs
      .readdirSync(coursesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);

    for (const dir of dirs) {
      const courseFolder = path.join(coursesDir, dir);
      const manifestPath = path.join(courseFolder, '.manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest: CourseManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest.group && manifest.group.trim() === groupName) {
            delete manifest.group;
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
            updatedCount++;
          }
        } catch (e) {
          console.error(`Failed to clear deleted group for ${dir}:`, e);
        }
      }
    }
    return updatedCount;
  }

  private static renameLibraryGroupOnDisk(oldName: string, newName: string): number {
    try {
      const manifest = LibraryService.loadManifest();
      let updatedCount = 0;
      for (const doc of manifest.documents) {
        if (doc.group && doc.group.trim().toLowerCase() === oldName.toLowerCase()) {
          doc.group = newName;
          updatedCount++;
        }
      }
      if (updatedCount > 0) {
        LibraryService.saveManifest(manifest);
      }
      return updatedCount;
    } catch (e) {
      console.error('Failed to rename library group on disk:', e);
      return 0;
    }
  }

  private static deleteLibraryGroupOnDisk(groupName: string): number {
    try {
      const manifest = LibraryService.loadManifest();
      let updatedCount = 0;
      for (const doc of manifest.documents) {
        if (doc.group && doc.group.trim().toLowerCase() === groupName.toLowerCase()) {
          delete doc.group;
          updatedCount++;
        }
      }
      if (updatedCount > 0) {
        LibraryService.saveManifest(manifest);
      }
      return updatedCount;
    } catch (e) {
      console.error('Failed to delete library group on disk:', e);
      return 0;
    }
  }
}
