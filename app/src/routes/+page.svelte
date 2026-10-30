<script module lang="ts">
  import type { CourseManifest } from '$lib/parser/courseIngest';

  let cachedCoursesList: CourseManifest[] | null = null;
</script>

<script lang="ts">
  import Header from '$lib/components/Header.svelte';
  import UploadModal from '$lib/components/UploadModal.svelte';
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
    ArchiveRestore,
    Trash2,
    Upload,
    QrCode,
    Download,
    ChevronDown,
    ListCollapse,
    Paperclip,
    FileCode,
    ScrollText,
    ExternalLink
  } from 'lucide-svelte';
  import DocumentViewerModal from '$lib/components/DocumentViewerModal.svelte';
  import RenameCourseModal from '$lib/components/RenameCourseModal.svelte';
  import { apiFetch, isTauriDesktop, isTauriEnvironment } from '$lib/api';
  import { openScanDesktopModal } from '$lib/modalState.svelte';
  import { stripCourseCodePrefix } from '$lib/courses';
  import { confirmDialog } from '$lib/dialog';
  import { buildCourseAggregatedMarkdown, type CoursePdfExportType } from '$lib/pdf/coursePdfAggregator';
  import { exportDocumentToPdf } from '$lib/pdf/exportPdf';
  import { getResumeLastPosition, buildCourseResumeUrl } from '$lib/preferences';

  const isTauri = isTauriEnvironment();
  let courses: CourseManifest[] = $state(cachedCoursesList || []);
  let isLoading = $state(!cachedCoursesList || cachedCoursesList.length === 0);
  let searchQuery = $state('');
  let isUploadModalOpen = $state(false);
  let busyCourseId = $state<string | null>(null);
  let openMenuCourseId = $state<string | null>(null);
  let openDownloadCourseId = $state<string | null>(null);
  let exportingCourseId = $state<string | null>(null);
  let exportingType = $state<CoursePdfExportType | null>(null);
  let renamingCourse = $state<CourseManifest | null>(null);
  let isRenameModalOpen = $state(false);

  interface LockerDoc {
    filename: string;
    size: number;
    updatedAt: string;
    url: string;
    ext: string;
  }

  let activeLockerDropdownCourseId = $state<string | null>(null);
  let lockerDocsByCourse = $state<Record<string, LockerDoc[]>>({});
  let isLoadingLockerDocs = $state(false);
  let isUploadingLockerDoc = $state(false);
  let activeDocument = $state<{ url: string; title: string; courseTitle?: string } | null>(null);

  async function fetchLockerDocs(courseId: string, force = false) {
    if (!force && lockerDocsByCourse[courseId]) return;
    isLoadingLockerDocs = true;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/locker-docs`);
      if (res.ok) {
        const data = await res.json();
        lockerDocsByCourse[courseId] = Array.isArray(data.files) ? data.files : [];
        lockerDocsByCourse = { ...lockerDocsByCourse };
      }
    } catch (err) {
      console.error(`Failed to fetch locker docs for ${courseId}:`, err);
    } finally {
      isLoadingLockerDocs = false;
    }
  }

  function toggleLockerDropdown(courseId: string) {
    if (activeLockerDropdownCourseId === courseId) {
      activeLockerDropdownCourseId = null;
    } else {
      activeLockerDropdownCourseId = courseId;
      openDownloadCourseId = null;
      openMenuCourseId = null;
      void fetchLockerDocs(courseId);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  async function handleUploadLockerDoc(e: Event, courseId: string) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    isUploadingLockerDoc = true;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch(`/api/courses/${courseId}/locker-docs`, {
        method: 'POST',
        body: formData
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || 'Failed to upload document');
      }
      await fetchLockerDocs(courseId, true);
    } catch (err) {
      console.error('Failed to upload locker document:', err);
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      isUploadingLockerDoc = false;
      input.value = '';
    }
  }

  function handleOpenLockerDoc(doc: LockerDoc, course: CourseManifest) {
    activeLockerDropdownCourseId = null;
    activeDocument = {
      url: doc.url,
      title: doc.filename,
      courseTitle: course.title
    };
  }

  function openCourseDoc(courseId: string, tab: 'test' | 'logs') {
    goto(`/courses/${courseId.toLowerCase()}/course/${tab}`);
  }

  function openCourse(courseId: string) {
    if (getResumeLastPosition()) {
      goto(buildCourseResumeUrl(courseId));
    } else {
      goto(`/courses/${courseId}`);
    }
  }

  async function handleDownloadCoursePdf(course: CourseManifest, type: CoursePdfExportType) {
    openDownloadCourseId = null;
    exportingCourseId = course.id;
    exportingType = type;
    try {
      const result = await buildCourseAggregatedMarkdown(course, type);
      if (result.itemCount === 0) {
        const label = type === 'lesson' ? 'lesson notes' : type === 'summary' ? 'summaries' : 'study-help notes';
        alert(`No ${label} found for this course yet.`);
        return;
      }
      await exportDocumentToPdf({
        courseCode: course.id,
        courseTitle: course.title,
        lessonId: 'Course',
        lessonTitle: result.categoryTitle,
        tab: type,
        tabDisplayName: result.categoryTitle,
        rawMarkdown: result.markdown
      });
    } catch (err) {
      console.error(`Failed to export course ${type} PDF:`, err);
      alert('Failed to generate course PDF. Please check the browser console for details.');
    } finally {
      exportingCourseId = null;
      exportingType = null;
    }
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

  async function loadCourses(forceLoading = false) {
    if (forceLoading || courses.length === 0) {
      isLoading = true;
    }
    try {
      const res = await apiFetch('/api/courses');
      if (res.ok) {
        const data = await res.json();
        const list = data.courses || [];
        courses = list;
        cachedCoursesList = list;
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

  async function handleDeleteClick(course: CourseManifest) {
    const label = stripCourseCodePrefix(course.title, course.id);
    const confirmed = await confirmDialog(
      `Permanently delete "${label}" (${course.id.toUpperCase()})?\n\nThis will delete the whole directory for that course on disk. This action cannot be undone.`,
      'Delete Course'
    );
    if (!confirmed) return;

    busyCourseId = course.id;
    try {
      const res = await apiFetch(`/api/courses/${course.id}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.message || 'Failed to delete course. Please try again.');
        return;
      }
      await loadCourses();
    } catch (e) {
      console.error('Failed to delete course:', e);
      alert('Could not reach the server — please try again.');
    } finally {
      busyCourseId = null;
    }
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
    if (e.key === 'Escape') {
      openMenuCourseId = null;
      openDownloadCourseId = null;
    }
  }}
/>

<Header />

<main class="flex-1 overflow-y-auto px-0 py-3 space-y-4 sm:px-4 sm:py-6 sm:space-y-8 max-w-6xl mx-auto w-full">
  <!-- Page Hero & Search -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-1.5 sm:px-0">
    <div>
      <h1 class="text-xl sm:text-2xl font-bold tracking-tight text-stone-900 dark:text-stone-100">Active Courses</h1>
      <p class="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
        Click on a course to dive in. 
      </p>
    </div>

    <div class="flex items-center space-x-2">
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
        onclick={() => goto('/builder')}
        class="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-white transition shadow-2xs shrink-0 cursor-pointer"
      >
        <Plus class="w-3.5 h-3.5" />
        <span>Add Course</span>
      </button>
    </div>
  </div>

  <!-- Course Cards Grid -->
  {#if isLoading}
    <div class="flex flex-col divide-y divide-stone-200/60 dark:divide-stone-800/60 sm:grid sm:grid-cols-2 lg:grid-cols-3 sm:gap-6 sm:divide-y-0">
      {#each [1, 2, 3] as _}
        <div class="h-44 px-1.5 py-4 sm:h-56 sm:rounded-2xl sm:border sm:border-stone-200 sm:dark:border-stone-800 sm:bg-white sm:dark:bg-stone-900 sm:p-6 sm:shadow-2xs animate-pulse space-y-4">
          <div class="w-16 h-5 bg-stone-100 dark:bg-stone-800 rounded"></div>
          <div class="w-3/4 h-6 bg-stone-100 dark:bg-stone-800 rounded"></div>
          <div class="w-full h-12 bg-stone-100 dark:bg-stone-800 rounded"></div>
        </div>
      {/each}
    </div>
  {:else if filteredCourses.length === 0}
    <div class="mx-1.5 sm:mx-0 p-8 sm:p-12 text-center rounded-2xl border border-dashed border-stone-300 dark:border-stone-800 bg-white/50 dark:bg-stone-900/50 space-y-4">
      <div class="w-12 h-12 rounded-2xl bg-stone-100 dark:bg-stone-800 text-stone-400 flex items-center justify-center mx-auto">
        <BookOpen class="w-6 h-6" />
      </div>
      <div class="space-y-1">
        <h3 class="text-sm font-semibold text-stone-900 dark:text-stone-100">No courses available</h3>
        <p class="text-xs text-stone-500 dark:text-stone-400 max-w-sm mx-auto">
          {#if searchQuery}
            No courses matched "{searchQuery}".
          {:else}
            Scan your desktop app QR-code to download courses and start studying offline.
          {/if}
        </p>
      </div>

      {#if !isTauriDesktop() && !searchQuery}
        <div class="pt-2">
          <button
            type="button"
            onclick={openScanDesktopModal}
            class="inline-flex items-center space-x-2 px-4 py-2 rounded-xl bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-semibold shadow-xs hover:bg-stone-800 dark:hover:bg-white transition cursor-pointer"
          >
            <QrCode class="w-4 h-4" />
            <span>Scan Desktop QR-Code</span>
          </button>
        </div>
      {/if}
    </div>
  {:else}
    <div class="flex flex-col divide-y divide-stone-200/60 dark:divide-stone-800/60 sm:grid sm:grid-cols-2 lg:grid-cols-3 sm:gap-6 sm:divide-y-0">
      {#each filteredCourses as course}
        {@const totalLessons = course.units.reduce((acc, u) => acc + u.lessons.length, 0)}
        <div
          role="button"
          tabindex="0"
          aria-label="Open course {course.id}"
          onclick={() => openCourse(course.id)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openCourse(course.id);
            }
          }}
          class="group relative px-1.5 py-4 border-0 rounded-none bg-transparent shadow-none sm:rounded-2xl sm:border sm:border-stone-200 sm:dark:border-stone-800 sm:bg-white sm:dark:bg-stone-900 sm:p-6 sm:shadow-2xs sm:hover:shadow-md sm:hover:border-stone-300 sm:dark:hover:border-stone-700 transition flex flex-col justify-between cursor-pointer text-left {course.archived ? 'opacity-60 hover:opacity-100' : ''}"
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

              <button
                type="button"
                role="menuitem"
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openMenuCourseId = null;
                  openCourseDoc(course.id, 'logs');
                }}
                class="flex w-full items-center space-x-2 px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
              >
                <ScrollText class="w-3.5 h-3.5 text-stone-400" />
                <span>Logs</span>
              </button>

              <div class="my-1 border-t border-stone-100 dark:border-stone-800"></div>

              <button
                type="button"
                role="menuitem"
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openMenuCourseId = null;
                  handleDeleteClick(course);
                }}
                class="flex w-full items-center space-x-2 px-3 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition cursor-pointer"
              >
                <Trash2 class="w-3.5 h-3.5 text-red-500" />
                <span>Delete</span>
              </button>
            </div>
          {/if}

          <div class="space-y-3">
            <div>
              <h2 class="text-base font-semibold text-stone-900 dark:text-stone-100 group-hover:text-stone-700 dark:group-hover:text-stone-300 transition pr-7">
                <span class="px-1.5 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide shrink-0 bg-amber-400/10 dark:bg-amber-300/30 text-white ">
                  {course.id}
                </span> 
                {stripCourseCodePrefix(course.title, course.id)}
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
              <div class="text-xs text-stone-400 dark:text-stone-500 mt-0.5">Course Wide</div>
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
              <!-- Practice Test -->
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
                <span>Practice Test</span>
                {#if course.courseDocs?.test}
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Generated"></span>
                {/if}
              </button>


              <!-- Download Dropdown -->
              <div class="relative inline-flex items-center">
                {#if openDownloadCourseId === course.id}
                  <!-- Transparent click-catcher to dismiss menu -->
                  <div
                    role="presentation"
                    class="fixed inset-0 z-20"
                    onclick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openDownloadCourseId = null;
                    }}
                  ></div>
                {/if}

                <button
                  type="button"
                  title="Download aggregated course PDF"
                  aria-haspopup="menu"
                  aria-expanded={openDownloadCourseId === course.id}
                  disabled={exportingCourseId === course.id}
                  onclick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openDownloadCourseId = openDownloadCourseId === course.id ? null : course.id;
                  }}
                  class="inline-flex items-center justify-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 hover:text-stone-900 dark:hover:text-stone-100 text-stone-700 dark:text-stone-300 border border-stone-200 dark:border-stone-700 transition cursor-pointer disabled:opacity-50"
                >
                  {#if exportingCourseId === course.id}
                    <Loader2 class="w-3.5 h-3.5 animate-spin text-stone-500 dark:text-stone-400" />
                    <span>Exporting...</span>
                  {:else}
                    <Download class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400" />
                    <span>PDF</span>
                    <ChevronDown class="w-3 h-3 text-stone-400 dark:text-stone-500" />
                  {/if}
                </button>

                {#if openDownloadCourseId === course.id}
                  <div
                    role="menu"
                    tabindex="-1"
                    class="absolute left-0 bottom-full mb-1.5 w-56 rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-xl py-1 z-30 text-xs focus:outline-none divide-y divide-stone-100 dark:divide-stone-800"
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={() => {}}
                  >
                    <div class="px-3 py-1.5 text-[10px] uppercase font-semibold text-stone-400 dark:text-stone-500 tracking-wider">
                      Download PDF
                    </div>

                    <div class="py-1">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={exportingCourseId === course.id}
                        onclick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDownloadCoursePdf(course, 'lesson');
                        }}
                        class="flex w-full items-center justify-between px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer disabled:opacity-50"
                      >
                        <div class="flex items-center space-x-2">
                          <FileText class="w-3.5 h-3.5 text-stone-400 dark:text-stone-500" />
                          <span class="font-medium">Lessons</span>
                        </div>
                        <span class="text-[10px] font-medium text-stone-400">PDF</span>
                      </button>

                      <button
                        type="button"
                        role="menuitem"
                        disabled={exportingCourseId === course.id}
                        onclick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDownloadCoursePdf(course, 'summary');
                        }}
                        class="flex w-full items-center justify-between px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer disabled:opacity-50"
                      >
                        <div class="flex items-center space-x-2">
                          <Sparkles class="w-3.5 h-3.5 text-amber-500" />
                          <span class="font-medium">Summaries</span>
                        </div>
                        <span class="text-[10px] font-medium text-stone-400">PDF</span>
                      </button>

                      <button
                        type="button"
                        role="menuitem"
                        disabled={exportingCourseId === course.id}
                        onclick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDownloadCoursePdf(course, 'notes');
                        }}
                        class="flex w-full items-center justify-between px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer disabled:opacity-50"
                      >
                        <div class="flex items-center space-x-2">
                          <ListCollapse class="w-3.5 h-3.5 text-blue-500" />
                          <span class="font-medium">Study-Help Notes</span>
                        </div>
                        <span class="text-[10px] font-medium text-stone-400">PDF</span>
                      </button>
                    </div>
                  </div>
                {/if}
              </div>

              <!-- Attachments Dropdown (Locker Docs) -->
              <div class="relative inline-block text-left">
                <button
                  type="button"
                  title="Course attachments (locker documents)"
                  aria-expanded={activeLockerDropdownCourseId === course.id}
                  onclick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleLockerDropdown(course.id);
                  }}
                  class="inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 hover:text-stone-900 dark:hover:text-stone-100 text-stone-700 dark:text-stone-300 border border-stone-200 dark:border-stone-700 transition cursor-pointer"
                >
                  <Paperclip class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400" />
                  <span>Files</span>
                  <ChevronDown class="w-3 h-3 text-stone-400 transition-transform {activeLockerDropdownCourseId === course.id ? 'rotate-180' : ''}" />
                </button>

                {#if activeLockerDropdownCourseId === course.id}
                  <div
                    class="fixed inset-0 z-30"
                    onclick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      activeLockerDropdownCourseId = null;
                    }}
                    aria-hidden="true"
                  ></div>

                  <div
                    role="dialog"
                    tabindex="-1"
                    aria-label="Locker Documents"
                    class="absolute right-0 bottom-full mb-1 sm:bottom-auto sm:top-full sm:mt-1 w-72 sm:w-80 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-xl z-40 p-2 text-xs divide-y divide-stone-100 dark:divide-stone-800 animate-in fade-in zoom-in-95 duration-100"
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => {
                      if (e.key === 'Escape') activeLockerDropdownCourseId = null;
                    }}
                  >
                    <!-- Header -->
                    <div class="flex items-center justify-between px-2 py-1.5 text-stone-500 dark:text-stone-400 font-semibold text-[11px] uppercase tracking-wider">
                      <div class="flex items-center space-x-1.5">
                        <Paperclip class="w-3.5 h-3.5 text-stone-600 dark:text-stone-300" />
                        <span>Locker Documents</span>
                      </div>
                      {#if isLoadingLockerDocs}
                        <Loader2 class="w-3.5 h-3.5 animate-spin text-stone-400" />
                      {:else}
                        <span class="text-[10px] font-mono text-stone-400">
                          {(lockerDocsByCourse[course.id] || []).length} file{(lockerDocsByCourse[course.id] || []).length === 1 ? '' : 's'}
                        </span>
                      {/if}
                    </div>

                    <!-- Items List -->
                    <div class="max-h-56 overflow-y-auto py-1 space-y-0.5">
                      {#if isLoadingLockerDocs && !lockerDocsByCourse[course.id]}
                        <div class="py-4 text-center text-stone-400 text-xs flex items-center justify-center space-x-1.5">
                          <Loader2 class="w-3.5 h-3.5 animate-spin" />
                          <span>Loading documents...</span>
                        </div>
                      {:else if !lockerDocsByCourse[course.id] || lockerDocsByCourse[course.id].length === 0}
                        <div class="py-4 text-center text-stone-400 dark:text-stone-500 text-xs italic">
                          No locker documents found.
                        </div>
                      {:else}
                        {#each lockerDocsByCourse[course.id] as doc (doc.filename)}
                          <button
                            type="button"
                            onclick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleOpenLockerDoc(doc, course);
                            }}
                            class="flex items-center justify-between w-full p-2 rounded-lg text-left hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer group"
                            title="Open {doc.filename}"
                          >
                            <div class="flex items-center space-x-2 min-w-0 pr-2">
                              {#if doc.ext === 'pdf'}
                                <FileText class="w-4 h-4 text-rose-500 shrink-0" />
                              {:else if doc.ext === 'html' || doc.ext === 'htm'}
                                <FileCode class="w-4 h-4 text-blue-500 shrink-0" />
                              {:else}
                                <FileText class="w-4 h-4 text-stone-500 shrink-0" />
                              {/if}
                              <div class="min-w-0">
                                <p class="font-medium text-stone-800 dark:text-stone-200 truncate text-xs group-hover:text-stone-900 dark:group-hover:text-stone-100">
                                  {doc.filename}
                                </p>
                                <p class="text-[10px] text-stone-400 dark:text-stone-500 font-mono">
                                  {formatBytes(doc.size)}
                                </p>
                              </div>
                            </div>
                            <ExternalLink class="w-3.5 h-3.5 text-stone-400 opacity-0 group-hover:opacity-100 transition shrink-0" />
                          </button>
                        {/each}
                      {/if}
                    </div>

                    <!-- Upload Action -->
                    <div class="pt-2 px-1">
                      <label
                        class="flex items-center justify-center space-x-1.5 w-full px-2.5 py-1.5 rounded-lg border border-dashed border-stone-300 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-600 bg-stone-50 dark:bg-stone-950/60 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-300 text-xs font-medium transition cursor-pointer {isUploadingLockerDoc ? 'opacity-50 pointer-events-none' : ''}"
                      >
                        <input
                          type="file"
                          class="hidden"
                          accept=".pdf,.html,.htm,.txt,.md,.doc,.docx"
                          disabled={isUploadingLockerDoc}
                          onchange={(e) => handleUploadLockerDoc(e, course.id)}
                        />
                        {#if isUploadingLockerDoc}
                          <Loader2 class="w-3.5 h-3.5 animate-spin text-stone-500" />
                          <span>Uploading...</span>
                        {:else}
                          <Upload class="w-3.5 h-3.5 text-stone-500" />
                          <span>Upload Document</span>
                        {/if}
                      </label>
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        </div>
      {/each}
     
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

{#if activeDocument}
  <DocumentViewerModal
    url={activeDocument.url}
    title={activeDocument.title}
    courseTitle={activeDocument.courseTitle}
    onClose={() => (activeDocument = null)}
  />
{/if}
