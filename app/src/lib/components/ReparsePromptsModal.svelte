<script lang="ts">
  import { RotateCw, X, AlertTriangle, Loader2, CheckSquare, Square, FileText } from 'lucide-svelte';
  import { apiFetch } from '$lib/api';

  interface CourseOption {
    id: string;
    title: string;
  }

  interface Props {
    isOpen: boolean;
    initialCategory?: string;
    onClose: () => void;
    onSuccess: (result: { enqueuedCount: number; coursesCount: number }) => void;
  }

  let { isOpen, initialCategory, onClose, onSuccess }: Props = $props();

  const CATEGORIES = [
    {
      id: 'lesson_summaries',
      label: 'Lesson Summaries',
      description: 'Per-lesson summary notes',
      target: '<lesson_id>.summary.md',
      prompt: 'summary.md',
      attachment: 'lesson - lessons'
    },
    {
      id: 'lesson_notes',
      label: 'Lesson Notes',
      description: 'Per-lesson quick references & formulas',
      target: '<lesson_id>.notes.md',
      prompt: 'notes.md',
      attachment: 'lesson - lessons'
    },
    {
      id: 'unit_assignments',
      label: 'Unit Assignments',
      description: 'Comprehensive assignment reviews per unit',
      target: '<XX>.unit.assignments.md',
      prompt: 'unit_assignments.md',
      attachment: 'unit - lessons'
    },
    {
      id: 'unit_tests',
      label: 'Unit Tests',
      description: 'Practice exams & test preparation per unit',
      target: '<XX>.unit.test.md',
      prompt: 'unit_test.md',
      attachment: 'unit - lessons'
    },
    {
      id: 'course_summaries',
      label: 'Course Summaries',
      description: 'High-level synthesis for the entire course',
      target: 'course.summary.md',
      prompt: 'course_summary.md',
      attachment: 'course - summaries'
    },
    {
      id: 'course_notes',
      label: 'Course Notes',
      description: 'Master reference notes for the course',
      target: 'course.notes.md',
      prompt: 'course_notes.md',
      attachment: 'course - notes'
    },
    {
      id: 'course_tests',
      label: 'Course Final Tests',
      description: 'Final cumulative course test questions',
      target: 'course.test.md',
      prompt: 'course_test.md',
      attachment: 'course - lessons'
    }
  ] as const;

  type CategoryId = (typeof CATEGORIES)[number]['id'];

  let selectedCourse = $state<string>('all');
  let selectedCategories = $state<Set<CategoryId>>(new Set(CATEGORIES.map((c) => c.id)));
  let courses = $state<CourseOption[]>([]);
  let isLoadingCourses = $state(false);
  let isSubmitting = $state(false);
  let errorMessage = $state<string | null>(null);

  $effect(() => {
    if (isOpen) {
      errorMessage = null;
      isSubmitting = false;
      const validCategory = CATEGORIES.find((c) => c.id === initialCategory);
      if (validCategory) {
        selectedCategories = new Set([validCategory.id]);
      } else {
        selectedCategories = new Set(CATEGORIES.map((c) => c.id));
      }
      loadCourses();
    }
  });

  async function loadCourses() {
    isLoadingCourses = true;
    try {
      const res = await apiFetch('/api/courses');
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data.courses) ? data.courses : [];
        courses = list.map((c: any) => ({
          id: c.id,
          title: c.title || c.id.toUpperCase()
        }));
      }
    } catch {
      // Fallback: silently retain empty courses (defaults to 'all')
    } finally {
      isLoadingCourses = false;
    }
  }

  function toggleCategory(id: CategoryId) {
    const next = new Set(selectedCategories);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    selectedCategories = next;
  }

  function selectAll() {
    selectedCategories = new Set(CATEGORIES.map((c) => c.id));
  }

  function deselectAll() {
    selectedCategories = new Set();
  }

  async function handleRefresh() {
    if (selectedCategories.size === 0) {
      errorMessage = 'Please select at least one sheet category to regenerate.';
      return;
    }

    isSubmitting = true;
    errorMessage = null;

    const categoriesToSend = Array.from(selectedCategories).flatMap((cat) => {
      if (cat === 'lesson_notes' || (cat as string) === 'lesson_studysheets') return ['lesson_notes', 'lesson_studysheets', 'lesson_cheatsheets'];
      if (cat === 'course_notes' || (cat as string) === 'course_studysheets') return ['course_notes', 'course_studysheets', 'course_cheatsheets'];
      return [cat];
    });

    try {
      const res = await apiFetch('/api/maintenance/reparse-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId: selectedCourse,
          categories: categoriesToSend
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Request failed with status ${res.status}`);
      }

      const data = await res.json();
      onSuccess({
        enqueuedCount: data.enqueuedCount || 0,
        coursesCount: data.coursesCount || 0
      });
      onClose();
    } catch (err: any) {
      errorMessage = err?.message || 'Failed to enqueue reparse tasks.';
    } finally {
      isSubmitting = false;
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (isOpen && e.key === 'Escape' && !isSubmitting) onClose();
  }}
/>

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/50 dark:bg-black/70 backdrop-blur-xs">
    <!-- Backdrop click to close -->
    <button
      type="button"
      class="absolute inset-0 w-full h-full cursor-default"
      onclick={() => {
        if (!isSubmitting) onClose();
      }}
      aria-label="Close modal overlay"
      tabindex="-1"
    ></button>

    <div
      class="relative z-10 w-full max-w-xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-stone-100 dark:border-stone-800 shrink-0">
        <div class="flex items-center space-x-2.5">
          <div class="p-2 rounded-xl bg-stone-900 dark:bg-stone-800 text-white dark:text-stone-200 shadow-2xs">
            <RotateCw class="w-4 h-4" />
          </div>
          <div>
            <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Reparse with Updated Prompts
            </h2>
            <p class="text-[11px] text-stone-500 dark:text-stone-400">
              Re-generate sheets using the latest prompt templates and default attachments
            </p>
          </div>
        </div>

        <button
          type="button"
          disabled={isSubmitting}
          onclick={onClose}
          class="p-1 rounded-md text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer disabled:opacity-50"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Scrollable Body -->
      <div class="px-5 py-4 space-y-4 overflow-y-auto text-xs">
        <!-- Course Selection -->
        <div class="space-y-1.5">
          <label for="reparse-course-select" class="block text-[11px] font-medium text-stone-700 dark:text-stone-300">
            Course Scope
          </label>
          <select
            id="reparse-course-select"
            bind:value={selectedCourse}
            disabled={isSubmitting}
            class="w-full px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 outline-none focus:ring-1 focus:ring-stone-400"
          >
            <option value="all">All Courses ({courses.length > 0 ? courses.length : 'registered'})</option>
            {#each courses as course (course.id)}
              <option value={course.id}>{course.id.toUpperCase()} — {course.title}</option>
            {/each}
          </select>
        </div>

        <!-- Categories Checklist -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-medium text-stone-700 dark:text-stone-300">
              Select Sheets to Regenerate
            </span>
            <div class="flex items-center space-x-2 text-[11px]">
              <button
                type="button"
                onclick={selectAll}
                disabled={isSubmitting}
                class="text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer disabled:opacity-50"
              >
                Select all
              </button>
              <span class="text-stone-300 dark:text-stone-700">•</span>
              <button
                type="button"
                onclick={deselectAll}
                disabled={isSubmitting}
                class="text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer disabled:opacity-50"
              >
                Deselect all
              </button>
            </div>
          </div>

          <div class="space-y-1.5 rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-950 p-2">
            {#each CATEGORIES as cat (cat.id)}
              {@const isChecked = selectedCategories.has(cat.id)}
              <label
                class="flex items-start space-x-3 p-2 rounded-lg cursor-pointer transition select-none {isChecked
                  ? 'bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xs'
                  : 'hover:bg-white/60 dark:hover:bg-stone-900/60 border border-transparent'}"
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={isSubmitting}
                  onchange={() => toggleCategory(cat.id)}
                  class="sr-only"
                />
                <div class="mt-0.5 text-stone-600 dark:text-stone-400 shrink-0">
                  {#if isChecked}
                    <CheckSquare class="w-4 h-4 text-stone-900 dark:text-stone-100" />
                  {:else}
                    <Square class="w-4 h-4 text-stone-400 dark:text-stone-600" />
                  {/if}
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-medium text-stone-900 dark:text-stone-100 text-xs">
                      {cat.label}
                    </span>
                    <span class="text-[10px] font-mono text-stone-400 dark:text-stone-500 shrink-0">
                      {cat.target}
                    </span>
                  </div>
                  <div class="flex items-center justify-between gap-2 mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">
                    <span>{cat.description}</span>
                    <span class="text-[10px] bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 rounded text-stone-600 dark:text-stone-300 shrink-0">
                      Prompt: {cat.prompt}
                    </span>
                  </div>
                </div>
              </label>
            {/each}
          </div>
        </div>

        <!-- Warning Callout -->
        <div class="flex items-start space-x-2.5 p-3 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200">
          <AlertTriangle class="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div class="space-y-0.5 text-[11px] leading-relaxed">
            <p class="font-semibold text-amber-950 dark:text-amber-100">
              Warning: Overwrite Notice
            </p>
            <p class="text-amber-800 dark:text-amber-300">
              The contents and front-matter prompts of the selected sheets will be overwritten with newly generated content using the latest prompt templates and default attachments. Unselected categories will remain completely untouched.
            </p>
          </div>
        </div>

        {#if errorMessage}
          <div class="p-2.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/30 text-red-700 dark:text-red-300 text-xs">
            {errorMessage}
          </div>
        {/if}
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-between px-5 py-3 border-t border-stone-100 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-950 shrink-0">
        <span class="text-[11px] text-stone-500 dark:text-stone-400">
          {selectedCategories.size} of {CATEGORIES.length} selected
        </span>

        <div class="flex items-center space-x-2">
          <button
            type="button"
            onclick={onClose}
            disabled={isSubmitting}
            class="px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs font-medium text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-700 transition cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>

          <button
            type="button"
            onclick={handleRefresh}
            disabled={isSubmitting || selectedCategories.size === 0}
            class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-white transition cursor-pointer disabled:opacity-50"
          >
            {#if isSubmitting}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Enqueuing...</span>
            {:else}
              <RotateCw class="w-3.5 h-3.5" />
              <span>Refresh</span>
            {/if}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
