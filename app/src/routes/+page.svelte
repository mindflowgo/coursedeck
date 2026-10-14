<script lang="ts">
  import Header from '$lib/components/Header.svelte';
  import UploadModal from '$lib/components/UploadModal.svelte';
  import type { CourseManifest } from '$lib/parser/courseIngest';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    BookOpen,
    Plus,
    Search,
    GraduationCap,
    Layers,
    FileText,
    Sparkles,
    CheckCircle2,
    ArrowRight,
    Folder,
    Loader2,
    MoreVertical,
    Pencil,
    Archive,
    ArchiveRestore
  } from 'lucide-svelte';
  import RenameCourseModal from '$lib/components/RenameCourseModal.svelte';
  import { apiFetch, isTauriEnvironment } from '$lib/api';
  import { stripCourseCodePrefix } from '$lib/courses';
  import { confirmDialog } from '$lib/dialog';

  let courses: CourseManifest[] = $state([]);
  let isLoading = $state(true);
  let searchQuery = $state('');
  let isUploadModalOpen = $state(false);
  let busyCourseId = $state<string | null>(null);
  let openMenuCourseId = $state<string | null>(null);
  let renamingCourse = $state<CourseManifest | null>(null);
  let isRenameModalOpen = $state(false);

  function openCourseDoc(courseId: string, tab: 'lesson' | 'summary' | 'cheatsheet' | 'test' | 'schedule') {
    goto(`/courses/${courseId}?scope=course&tab=${tab}`);
  }

  async function openCourseFolder(courseId: string, path?: string) {
    if (isTauriEnvironment()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_course_folder', { courseId, path });
        return;
      } catch (err) {
        console.error('Failed to open course folder via Tauri:', err);
      }
    }

    try {
      const res = await apiFetch(`/api/courses/${courseId}/open`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Failed to open course folder via API:', data.error || res.statusText);
      }
    } catch (e) {
      console.error('Failed to open course folder:', e);
    }
  }

  async function loadCourses() {
    isLoading = true;
    try {
      const res = await apiFetch('/api/courses');
      if (res.ok) {
        const data = await res.json();
        courses = data.courses || [];
      }
    } catch (e) {
      console.error('Failed to load courses:', e);
    } finally {
      isLoading = false;
    }
  }

  onMount(() => {
    loadCourses();
  });

  function handleCourseUploaded(courseId: string) {
    loadCourses();
    goto(`/courses/${courseId}`);
  }

  async function updateCourseMeta(courseId: string, patch: Record<string, unknown>) {
    busyCourseId = courseId;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/meta`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.message || 'Failed to update course. Please try again.');
        return;
      }
      await loadCourses();
    } catch (e) {
      console.error('Failed to update course metadata:', e);
      alert('Could not reach the server — please try again.');
    } finally {
      busyCourseId = null;
    }
  }

  async function handleArchiveClick(course: CourseManifest) {
    const label = stripCourseCodePrefix(course.title, course.id);
    const confirmed = await confirmDialog(
      `Archive course "${label}"?\n\nIt will be hidden from your course and schedule listings, but stays searchable here.`,
      'Archive Course'
    );
    if (confirmed) {
      updateCourseMeta(course.id, { archived: true });
    }
  }

  function handleRestoreClick(course: CourseManifest) {
    updateCourseMeta(course.id, { archived: false });
  }

  async function handleRenameSave(title: string, description: string): Promise<boolean> {
    if (!renamingCourse) return false;
    const courseId = renamingCourse.id;
    busyCourseId = courseId;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/meta`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Failed to rename course:', data.message || res.statusText);
        return false;
      }
      await loadCourses();
      return true;
    } catch (e) {
      console.error('Failed to rename course:', e);
      return false;
    } finally {
      busyCourseId = null;
    }
  }

  let filteredCourses = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    const matches = (c: CourseManifest) =>
      c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
    if (!q) return courses.filter((c) => !c.archived);
    // Searching still surfaces archived courses (after active ones) so they
    // can be opened or restored.
    const active = courses.filter((c) => !c.archived && matches(c));
    const archived = courses.filter((c) => c.archived && matches(c));
    return [...active, ...archived];
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') openMenuCourseId = null;
  }}
/>

<Header />

<main class="flex-1 overflow-y-auto px-4 py-8 sm:px-8 max-w-6xl mx-auto w-full space-y-8">
  <!-- Page Hero & Search -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold tracking-tight text-stone-900 dark:text-stone-100">Your Courses</h1>
      <p class="text-xs text-stone-500 dark:text-stone-400 mt-1">
        Distraction-free study notes, summaries, cheatsheets, and interactive practice tests.
      </p>
    </div>

    <div class="flex items-center space-x-3">
      <div class="relative w-full sm:w-64">
        <Search class="absolute left-3 top-2.5 w-3.5 h-3.5 text-stone-400 dark:text-stone-500" />
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="Filter courses..."
          class="w-full pl-9 pr-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition"
        />
      </div>

      <button
        onclick={() => (isUploadModalOpen = true)}
        class="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-white transition shadow-2xs shrink-0 cursor-pointer"
      >
        <Plus class="w-3.5 h-3.5" />
        <span>Add Course</span>
      </button>
    </div>
  </div>

  <!-- Course Cards Grid -->
  {#if isLoading}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {#each [1, 2, 3] as _}
        <div class="h-56 rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 animate-pulse space-y-4">
          <div class="w-16 h-5 bg-stone-100 dark:bg-stone-800 rounded"></div>
          <div class="w-3/4 h-6 bg-stone-100 dark:bg-stone-800 rounded"></div>
          <div class="w-full h-12 bg-stone-100 dark:bg-stone-800 rounded"></div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {#each filteredCourses as course}
        {@const totalLessons = course.units.reduce((acc, u) => acc + u.lessons.length, 0)}
        <a
          href="/courses/{course.id}"
          class="group relative rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 shadow-2xs hover:shadow-md hover:border-stone-300 dark:hover:border-stone-700 transition flex flex-col justify-between {course.archived ? 'opacity-60 hover:opacity-100' : ''}"
        >
          {#if openMenuCourseId === course.id}
            <!-- Transparent click-catcher: closes the menu on any outside click
                 without letting it navigate the card link. -->
            <div
              role="presentation"
              class="fixed inset-0 z-10"
              onclick={(e) => {
                e.preventDefault();
                openMenuCourseId = null;
              }}
            ></div>
          {/if}
          <button
            type="button"
            title="Course options"
            aria-label="Course options"
            aria-haspopup="menu"
            aria-expanded={openMenuCourseId === course.id}
            disabled={busyCourseId === course.id}
            onclick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openMenuCourseId = openMenuCourseId === course.id ? null : course.id;
            }}
            class="absolute top-3 right-3 z-20 p-1 rounded-md text-stone-300 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            {#if busyCourseId === course.id}
              <Loader2 class="w-4 h-4 animate-spin" />
            {:else}
              <MoreVertical class="w-4 h-4" />
            {/if}
          </button>

          {#if openMenuCourseId === course.id}
            <div
              role="menu"
              tabindex="-1"
              class="absolute top-9 right-3 z-30 w-36 rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-lg py-1 text-xs focus:outline-none"
              onclick={(e) => e.preventDefault()}
              onkeydown={() => {}}
            >
              <button
                type="button"
                role="menuitem"
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openMenuCourseId = null;
                  renamingCourse = course;
                  isRenameModalOpen = true;
                }}
                class="flex w-full items-center space-x-2 px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
              >
                <Pencil class="w-3.5 h-3.5 text-stone-400" />
                <span>Rename</span>
              </button>

              {#if course.archived}
                <button
                  type="button"
                  role="menuitem"
                  onclick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openMenuCourseId = null;
                    handleRestoreClick(course);
                  }}
                  class="flex w-full items-center space-x-2 px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
                >
                  <ArchiveRestore class="w-3.5 h-3.5 text-stone-400" />
                  <span>Restore</span>
                </button>
              {:else}
                <button
                  type="button"
                  role="menuitem"
                  onclick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openMenuCourseId = null;
                    handleArchiveClick(course);
                  }}
                  class="flex w-full items-center space-x-2 px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
                >
                  <Archive class="w-3.5 h-3.5 text-stone-400" />
                  <span>Archive</span>
                </button>
              {/if}
            </div>
          {/if}

          <div class="space-y-3">
            <div>
              <h2 class="text-base font-semibold text-stone-900 dark:text-stone-100 group-hover:text-stone-700 dark:group-hover:text-stone-300 transition pr-7">
                <span class="text-sm font-mono font-black uppercase tracking-widest px-1.5 py-1 rounded-md bg-amber-400/10 dark:bg-amber-300/30 text-white border-2 border-amber-500 dark:border-amber-400 shadow-sm">
                {course.id}
              </span> {stripCourseCodePrefix(course.title, course.id)}
              </h2>
            </div>

            <!-- Stats & Pills -->
            <div class="flex flex-wrap items-center gap-2 pt-2 text-[11px] text-stone-600 dark:text-stone-400">
              {#if course.archived}
                <div class="flex items-center space-x-1 px-2 py-1 rounded bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 font-medium uppercase tracking-wide">
                  <span>Archived</span>
                </div>
              {/if}
              <div class="flex items-center space-x-1 px-2 py-1 rounded bg-stone-50 dark:bg-stone-800/60 border border-stone-100 dark:border-stone-700/80">
                <Layers class="w-3 h-3 text-stone-400 dark:text-stone-500" />
                <span>{course.units.length} Units</span>
              </div>
              <div class="flex items-center space-x-1 px-2 py-1 rounded bg-stone-50 dark:bg-stone-800/60 border border-stone-100 dark:border-stone-700/80">
                <FileText class="w-3 h-3 text-stone-400 dark:text-stone-500" />
                <span>{totalLessons} Lessons</span>
              </div>
            <ArrowRight class="w-4 h-4 transform group-hover:translate-x-1 transition" />
            </div>
          </div>

          <!-- Bottom Footer -->
          <div class="mt-1 pt-2 border-t border-stone-100 dark:border-stone-800">
            <div class="flex items-center justify-between">
              <div class="text-xs text-stone-400 dark:text-stone-500 mt-0.5">Complete Course</div>
              <button
                type="button"
                title="Open course folder"
                aria-label="Open course folder"
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openCourseFolder(course.id, course.path);
                }}
                class="p-1 -mr-1 rounded-md text-stone-400 dark:text-stone-500 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 hover:border-stone-200 dark:hover:border-stone-700 border border-transparent transition cursor-pointer"
              >
                <Folder class="w-3.5 h-3.5" />
              </button>
            </div>

            <div class="flex flex-wrap items-center gap-1.5 mt-2">
              <!-- Notes -->
              <button
                type="button"
                title="View complete course lessons"
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openCourseDoc(course.id, 'lesson');
                }}
                class="inline-flex items-center justify-center px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 hover:text-stone-900 dark:hover:text-stone-100 text-stone-700 dark:text-stone-300 border border-stone-200 dark:border-stone-700 transition cursor-pointer"
              >
                <span>Lessons</span>
              </button>

              <!-- Summary -->
              <button
                type="button"
                title={course.courseDocs?.summary ? 'View Course Summary' : 'Generate Course Summary'}
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openCourseDoc(course.id, 'summary');
                }}
                class="inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 hover:text-stone-900 dark:hover:text-stone-100 text-stone-700 dark:text-stone-300 border border-stone-200 dark:border-stone-700 transition cursor-pointer"
              >
                <span>Summary</span>
                {#if course.courseDocs?.summary}
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Generated"></span>
                {/if}
              </button>

              <!-- Cheatsheet -->
              <button
                type="button"
                title={course.courseDocs?.cheatsheet ? 'View Master Course Cheatsheet' : 'Generate Course Cheatsheet'}
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openCourseDoc(course.id, 'cheatsheet');
                }}
                class="inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 hover:text-stone-900 dark:hover:text-stone-100 text-stone-700 dark:text-stone-300 border border-stone-200 dark:border-stone-700 transition cursor-pointer"
              >
                <span>Mem-Aids</span>
                {#if course.courseDocs?.cheatsheet}
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Generated"></span>
                {/if}
              </button>

              <!-- Test -->
              <button
                type="button"
                title={course.courseDocs?.test ? 'View Course Practice Test' : 'Generate Course Practice Test'}
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openCourseDoc(course.id, 'test');
                }}
                class="inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 hover:text-stone-900 dark:hover:text-stone-100 text-stone-700 dark:text-stone-300 border border-stone-200 dark:border-stone-700 transition cursor-pointer"
              >
                <span>Test</span>
                {#if course.courseDocs?.test}
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Generated"></span>
                {/if}
              </button>

              <!-- Schedule -->
              <button
                type="button"
                title={course.courseDocs?.schedule ? 'View Course Schedule' : 'Build Course Schedule'}
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openCourseDoc(course.id, 'schedule');
                }}
                class="inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 hover:text-stone-900 dark:hover:text-stone-100 text-stone-700 dark:text-stone-300 border border-stone-200 dark:border-stone-700 transition cursor-pointer"
              >
                <span>Schedule</span>
                {#if course.courseDocs?.schedule}
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Generated"></span>
                {/if}
              </button>
            </div>
          </div>
        </a>
      {/each}

      <!-- Add New Course Card -->
      <button
        onclick={() => (isUploadModalOpen = true)}
        class="h-full min-h-[220px] rounded-2xl border-2 border-dashed border-stone-200 dark:border-stone-800 hover:border-stone-400 dark:hover:border-stone-600 hover:bg-stone-50/50 dark:hover:bg-stone-900/50 p-6 flex flex-col items-center justify-center text-center space-y-3 transition group cursor-pointer"
      >
        <div class="w-10 h-10 rounded-full bg-stone-100 group-hover:bg-stone-200 text-stone-600 flex items-center justify-center transition">
          <Plus class="w-5 h-5" />
        </div>
        <div>
          <div class="text-sm font-semibold text-stone-800">Add New Course</div>
          <p class="text-xs text-stone-400 mt-0.5">Upload a block of ILC course content (.zip)</p>
        </div>
      </button>
    </div>
  {/if}
</main>

<UploadModal
  isOpen={isUploadModalOpen}
  onClose={() => (isUploadModalOpen = false)}
  onUploaded={handleCourseUploaded}
/>

<RenameCourseModal
  isOpen={isRenameModalOpen}
  onClose={() => (isRenameModalOpen = false)}
  onSave={handleRenameSave}
  courseId={renamingCourse?.id ?? ''}
  title={renamingCourse?.title ?? ''}
  description={renamingCourse?.description ?? ''}
/>
