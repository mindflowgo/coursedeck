<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import Header from '$lib/components/Header.svelte';
  import QuizRunner from '$lib/components/QuizRunner.svelte';
  import { apiFetch } from '$lib/api';
  import {
    ArrowLeft,
    Sparkles,
    Loader2,
    AlertCircle,
    CheckCircle2,
    Clock,
    RefreshCw
  } from 'lucide-svelte';

  let courseId = $derived($page.params.course_id || '');
  let lessonId = $derived($page.params.lesson || '');
  let timestamp = $derived($page.params.timestamp || '');

  let lessonTitle = $state('');
  let testMarkdown = $state('');
  let isLoading = $state(true);
  let isSubmitting = $state(false);
  let isMarkingDone = $state(false);
  let errorMessage = $state('');
  let supervisorMessage = $state('');
  let quizRunnerKey = $state(0);

  function formatDisplayTimestamp(raw: string): string {
    if (!raw) return '';
    // Format YYYY-MM-DD_HH-mm-ss or ISO into human readable
    const cleaned = raw.replace(/_/g, ' ').replace(/-/g, (m, offset) => offset > 10 ? ':' : '-');
    return cleaned;
  }

  async function loadLessonMeta() {
    try {
      const res = await apiFetch(`/api/courses/${courseId}/${lessonId}`);
      if (res.ok) {
        const bundle = await res.json();
        const firstLine = (bundle.lesson || '').split('\n').find((l: string) => l.startsWith('# '));
        lessonTitle = firstLine ? firstLine.replace(/^#\s+/, '').trim() : lessonId;
      }
    } catch {}
  }

  async function fetchOrGeneratePopQuiz(forceRegenerate = false) {
    isLoading = true;
    errorMessage = '';
    supervisorMessage = '';

    try {
      await loadLessonMeta();

      const res = await apiFetch('/api/pop-quiz/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId,
          lessonId,
          timestamp,
          forceRegenerate
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || data.error || 'Failed to generate pop quiz');
      }

      testMarkdown = data.markdown || '';
      quizRunnerKey++;
    } catch (err: any) {
      console.error('[PopQuiz Load Error]', err);
      errorMessage = err?.message || 'Error loading pop quiz. Please ensure your AI model is configured.';
    } finally {
      isLoading = false;
    }
  }

  async function handleSubmitPopQuiz(answers: Record<string, string>, timeSpentSeconds: number, timedOut: boolean) {
    isSubmitting = true;
    try {
      const res = await apiFetch('/api/pop-quiz/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId,
          lessonId,
          lessonTitle,
          timestamp,
          testMarkdown,
          answers,
          timeSpentSeconds,
          timedOut
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        supervisorMessage = data.supervisorMessage || 'Updated course supervisor, thank you!';
        if (data.emailError) {
          console.warn('[Supervisor Email Dispatch Notice]', data.emailError);
        }
      } else {
        alert(data.message || 'Quiz was graded, but could not be dispatched to supervisor.');
        supervisorMessage = 'Updated course supervisor, thank you!';
      }
    } catch (err: any) {
      console.error('[Quiz Submit Error]', err);
      alert('Error submitting quiz: ' + (err?.message || 'Check your connection.'));
      supervisorMessage = 'Updated course supervisor, thank you!';
    } finally {
      isSubmitting = false;
    }
  }

  async function handleMarkLessonDone() {
    if (isMarkingDone) return;
    isMarkingDone = true;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/schedule/mark-lesson-done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lessonId })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to update schedule');
      }

      if (data.nextLessonId) {
        await goto(`/courses/${courseId}/${data.nextLessonId}`);
      } else {
        await goto(`/courses/${courseId}`);
      }
    } catch (err: any) {
      console.error('[Mark Lesson Done Error]', err);
      alert('Could not mark lesson done: ' + (err?.message || 'Please check your connection.'));
    } finally {
      isMarkingDone = false;
    }
  }

  onMount(() => {
    fetchOrGeneratePopQuiz();
  });
</script>

<Header />

<div class="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden bg-stone-50/50 dark:bg-stone-950">
  <!-- Top Action & Navigation Bar -->
  <div class="border-b border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-2.5 flex items-center justify-between gap-3 shrink-0">
    <div class="flex items-center space-x-3">
      <button
        onclick={() => goto(`/courses/${courseId}/${lessonId}`)}
        class="inline-flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 text-stone-700 dark:text-stone-300 text-xs font-medium transition cursor-pointer shadow-2xs"
        title="Return to lesson"
      >
        <ArrowLeft class="w-3.5 h-3.5" />
        <span>Back to Lesson</span>
      </button>

      <div class="flex items-center space-x-2">
        <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wide bg-amber-400/10 dark:bg-amber-300/20 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700">
          {courseId.toUpperCase()}
        </span>
        <span class="text-xs font-semibold text-stone-800 dark:text-stone-200">
          Lesson {lessonId}
        </span>
        {#if lessonTitle}
          <span class="text-xs text-stone-400 dark:text-stone-500 hidden sm:inline">
            &bull; {lessonTitle}
          </span>
        {/if}
      </div>
    </div>

    <!-- Right Side: Attempt Timestamp Badge -->
    <div class="flex items-center space-x-2 text-[11px] text-stone-500 dark:text-stone-400">
      <span class="font-mono bg-stone-100 dark:bg-stone-800 px-2 py-0.5 rounded border border-stone-200 dark:border-stone-700">
        Attempt: {formatDisplayTimestamp(timestamp)}
      </span>
    </div>
  </div>

  <!-- Main Quiz Content Area -->
  <main class="flex-1 overflow-hidden max-w-4xl mx-auto w-full p-4 sm:p-6 flex flex-col min-h-0">
    {#if isLoading}
      <div class="flex-1 flex flex-col items-center justify-center space-y-4 p-8 text-center">
        <div class="relative">
          <div class="w-12 h-12 rounded-full border-2 border-emerald-500/20 border-t-emerald-600 animate-spin"></div>
          <Sparkles class="w-5 h-5 text-emerald-600 dark:text-emerald-400 absolute inset-0 m-auto" />
        </div>
        <div class="space-y-1">
          <h3 class="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Generating Random Pop Quiz...
          </h3>
          <p class="text-xs text-stone-500 dark:text-stone-400 max-w-sm">
            AI is testing the key ideas in Lesson {lessonId} with 4 multiple choice and 2 fill-in-the-blank questions.
          </p>
        </div>
      </div>
    {:else if errorMessage}
      <div class="flex-1 flex flex-col items-center justify-center space-y-4 p-8 text-center">
        <div class="p-3 rounded-full bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-600 dark:text-rose-400">
          <AlertCircle class="w-8 h-8" />
        </div>
        <div class="space-y-1">
          <h3 class="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Pop Quiz Unavailable
          </h3>
          <p class="text-xs text-rose-600 dark:text-rose-400 max-w-md">
            {errorMessage}
          </p>
        </div>
        <div class="flex items-center space-x-2 pt-2">
          <button
            onclick={() => fetchOrGeneratePopQuiz(true)}
            class="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition cursor-pointer"
          >
            <RefreshCw class="w-3.5 h-3.5" />
            <span>Try Again</span>
          </button>
          <button
            onclick={() => goto(`/courses/${courseId}/${lessonId}`)}
            class="px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 text-stone-700 dark:text-stone-300 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            Return to Lesson
          </button>
        </div>
      </div>
    {:else if testMarkdown}
      {#key quizRunnerKey}
        <QuizRunner
          testMarkdown={testMarkdown}
          isPopQuiz={true}
          countdownSeconds={300}
          supervisorMessage={supervisorMessage}
          isSubmitting={isSubmitting}
          isMarkingDone={isMarkingDone}
          onMarkLessonDone={handleMarkLessonDone}
          onSubmitPopQuiz={handleSubmitPopQuiz}
        />
      {/key}
    {/if}
  </main>
</div>
