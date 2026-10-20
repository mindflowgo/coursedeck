<script lang="ts">
  import { QuestionParser, type ParsedQuiz, type QuizQuestion } from '$lib/parser/questionParser';
  import { CheckCircle2, XCircle, RotateCcw, HelpCircle, Award, Clock, Send, Loader2 } from 'lucide-svelte';
  import DOMPurify from 'dompurify';
  import { renderTextWithMath } from '$lib/markdown/mathRenderer';
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    testMarkdown: string;
    onSaveMarkdown?: (newMarkdown: string) => void;
    isPopQuiz?: boolean;
    countdownSeconds?: number;
    supervisorMessage?: string;
    isSubmitting?: boolean;
    isMarkingDone?: boolean;
    onMarkLessonDone?: () => Promise<void>;
    onSubmitPopQuiz?: (answers: Record<string, string>, timeSpentSeconds: number, timedOut: boolean) => Promise<void>;
  }

  let {
    testMarkdown,
    onSaveMarkdown,
    isPopQuiz = false,
    countdownSeconds = 300,
    supervisorMessage = '',
    isSubmitting = false,
    isMarkingDone = false,
    onMarkLessonDone,
    onSubmitPopQuiz
  }: Props = $props();

  function mathHtml(text: string): string {
    const rendered = renderTextWithMath(text);
    if (typeof window === 'undefined') return rendered;
    const purify = typeof DOMPurify.sanitize === 'function' ? DOMPurify : (DOMPurify as any)(window);
    if (!purify || typeof purify.sanitize !== 'function') return rendered;
    return purify.sanitize(rendered, { ADD_TAGS: ['details', 'summary', 'mark'] });
  }

  let userAnswers: Record<string, string> = $state({});
  let submitted: boolean = $state(false);
  let timedOutState: boolean = $state(false);

  // Timer state for PopQuiz mode (5-minute countdown)
  let remainingSeconds: number = $state(0);
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let timerStarted: boolean = $state(false);

  function startTimer() {
    if (!isPopQuiz || timerStarted) return;
    timerStarted = true;
    remainingSeconds = countdownSeconds;
    timerInterval = setInterval(() => {
      if (submitted) {
        if (timerInterval) clearInterval(timerInterval);
        return;
      }
      if (remainingSeconds > 0) {
        remainingSeconds--;
      } else {
        if (timerInterval) clearInterval(timerInterval);
        timedOutState = true;
        handleSubmitQuiz(true);
      }
    }, 1000);
  }

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  let timeSpentSecondsState: number = $state(0);

  function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  }

  onMount(() => {
    if (isPopQuiz) {
      startTimer();
    }
  });

  onDestroy(() => {
    if (timerInterval) clearInterval(timerInterval);
  });

  $effect(() => {
    testMarkdown;
    userAnswers = {};
    submitted = false;
    timedOutState = false;
    timeSpentSecondsState = 0;
  });

  let parsedQuiz: ParsedQuiz = $derived.by(() => {
    return QuestionParser.parseMarkdown(testMarkdown);
  });

  let totalQuestions = $derived(parsedQuiz.questions.length);

  function isQuestionCorrect(q: QuizQuestion, pick?: string): boolean {
    if (!q.correctAnswer || !pick) return false;
    if (q.type === 'fill-in-the-blank') {
      const cleanStudent = pick.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const cleanCorrect = q.correctAnswer.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      return cleanStudent.length > 0 && (cleanStudent === cleanCorrect || cleanCorrect.includes(cleanStudent) || cleanStudent.includes(cleanCorrect));
    }
    return pick.toUpperCase() === q.correctAnswer.toUpperCase();
  }

  let score = $derived.by(() => {
    if (!submitted) return 0;
    return parsedQuiz.questions.reduce((acc, q) => {
      return acc + (isQuestionCorrect(q, userAnswers[q.number]) ? 1 : 0);
    }, 0);
  });

  let percentage = $derived(
    totalQuestions > 0 ? Math.round((score / totalQuestions) * 100) : 0
  );

  function selectOption(qNum: string, optLetter: string) {
    if (submitted) return;
    userAnswers[qNum] = optLetter;
  }

  async function handleSubmitQuiz(timedOut = false) {
    if (submitted) return;
    if (timerInterval) clearInterval(timerInterval);
    const timeSpent = Math.max(0, countdownSeconds - remainingSeconds);
    timeSpentSecondsState = timeSpent;
    try {
      if (onSubmitPopQuiz) {
        await onSubmitPopQuiz(userAnswers, timeSpent, timedOut);
      }
    } finally {
      submitted = true;
    }
  }

  function resetQuiz() {
    userAnswers = {};
    submitted = false;
    timedOutState = false;
    timeSpentSecondsState = 0;
    if (isPopQuiz) {
      remainingSeconds = countdownSeconds;
      startTimer();
    }
  }
</script>

<div class="h-full flex flex-col">
  <!-- Quiz Header -->
  <div class="flex items-center justify-between pb-4 mb-4 border-b border-stone-200 dark:border-stone-800">
    <div>
      <h2 class="text-base font-semibold text-stone-900 dark:text-stone-100">{parsedQuiz.title}</h2>
      <p class="text-xs text-stone-500 dark:text-stone-400">
        {#if isPopQuiz}
          Accountability Pop Quiz &bull; {totalQuestions} Questions (4 Multiple Choice, 2 Fill-in-the-Blank)
        {:else}
          Ontario Curriculum Practice Test &bull; {totalQuestions} Questions
        {/if}
      </p>
    </div>

    <!-- 5-Minute Countdown Timer for PopQuiz -->
    {#if isPopQuiz && !submitted}
      <div class="flex items-center space-x-2 px-3 py-1.5 rounded-lg border shadow-2xs font-mono font-bold text-sm transition {
        remainingSeconds <= 30
          ? 'bg-rose-100 dark:bg-rose-950/70 border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 animate-pulse'
          : remainingSeconds <= 60
            ? 'bg-amber-50 dark:bg-amber-950/50 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300'
            : 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
      }">
        <Clock class="w-4 h-4 shrink-0" />
        <span>{formatTime(remainingSeconds)}</span>
      </div>
    {/if}
  </div>

  <!-- Interactive Quiz View -->
  <div class="flex-1 overflow-y-auto space-y-6 pr-2">
    <!-- Supervisor Sent Notification Banner (Regular test mode) -->
    {#if submitted && supervisorMessage && !isPopQuiz}
      <div class="p-3.5 rounded-xl border border-emerald-300 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200 flex items-center space-x-3 shadow-2xs animate-in fade-in duration-200">
        <CheckCircle2 class="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <div class="flex-1">
          <div class="text-xs font-bold tracking-wide uppercase">{supervisorMessage}</div>
          <div class="text-[11px] text-emerald-700 dark:text-emerald-300 mt-0.5">
            Your results, selected answers, and correct answers have been dispatched to your teacher supervisor.
          </div>
        </div>
      </div>
    {/if}

    <!-- Score Banner when Submitted (Regular test mode) -->
    {#if submitted && !isPopQuiz}
      <div class="p-4 rounded-xl border {percentage >= 75 ? 'border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/70 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200' : percentage >= 50 ? 'border-amber-200 dark:border-amber-800/60 bg-amber-50/70 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200' : 'border-rose-200 dark:border-rose-800/60 bg-rose-50/70 dark:bg-rose-950/40 text-rose-900 dark:text-rose-200'} flex items-center justify-between">
        <div class="flex items-center space-x-3">
          <div class="p-2 rounded-lg {percentage >= 75 ? 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300' : percentage >= 50 ? 'bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300' : 'bg-rose-100 dark:bg-rose-900/60 text-rose-700 dark:text-rose-300'}">
            <Award class="w-6 h-6" />
          </div>
          <div>
            <div class="text-sm font-semibold">
              Score: {score} / {totalQuestions} ({percentage}%)
              {#if timedOutState}
                <span class="ml-2 text-xs font-normal text-rose-600 dark:text-rose-400 font-sans">(5-minute timer expired)</span>
              {/if}
            </div>
            <p class="text-xs opacity-80 mt-0.5">
              {#if percentage >= 80}
                Excellent mastery of the lesson expectations!
              {:else if percentage >= 60}
                Solid performance. Review the explanations below for deeper reinforcement.
              {:else}
                Keep reviewing. Study the full lesson text to solidify these core concepts.
              {/if}
            </p>
          </div>
        </div>

        <button
          onclick={resetQuiz}
          class="flex items-center space-x-1 px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-200 text-xs font-medium hover:bg-stone-50 dark:hover:bg-stone-700 transition shadow-2xs cursor-pointer"
        >
          <RotateCcw class="w-3.5 h-3.5" />
          <span>Retake Quiz</span>
        </button>
      </div>
    {/if}

    <!-- Questions List -->
    {#each parsedQuiz.questions as q, index}
      {@const userPick = userAnswers[q.number]}
      {@const isCorrect = isQuestionCorrect(q, userPick)}

      <div class="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-2xs space-y-4">
        <!-- Question Header -->
        <div class="flex items-start justify-between">
          <div class="space-y-1">
            <div class="flex items-center space-x-2">
              <span class="text-xs font-mono font-bold text-stone-400 dark:text-stone-500">
                Q{q.number}
              </span>
              {#if q.category}
                <span class="text-[11px] px-2 py-0.5 rounded-full font-medium bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-700">
                  {q.category}
                </span>
              {/if}
              {#if q.type === 'fill-in-the-blank'}
                <span class="text-[10px] px-1.5 py-0.5 rounded font-mono uppercase bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                  Fill-in-the-Blank
                </span>
              {/if}
            </div>
            <h3 class="text-sm font-medium text-stone-900 dark:text-stone-100 leading-snug">
              {@html mathHtml(q.prompt)}
            </h3>
          </div>

          {#if submitted}
            <div class="shrink-0 ml-3">
              {#if isCorrect}
                <div class="flex items-center space-x-1 text-emerald-600 dark:text-emerald-400 text-xs font-semibold">
                  <CheckCircle2 class="w-5 h-5" />
                  <span>Correct</span>
                </div>
              {:else}
                <div class="flex items-center space-x-1 text-rose-600 dark:text-rose-400 text-xs font-semibold">
                  <XCircle class="w-5 h-5" />
                  <span>Incorrect</span>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Question Body (Multiple Choice vs Fill-in-the-Blank) -->
        {#if q.type === 'fill-in-the-blank'}
          <div class="space-y-2 pt-1">
            {#if !submitted}
              <div class="flex items-center space-x-2">
                <input
                  type="text"
                  bind:value={userAnswers[q.number]}
                  placeholder="Type your answer here..."
                  class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
                />
              </div>
            {:else}
              <div class="p-3 rounded-lg border text-xs {isCorrect ? 'border-emerald-500 dark:border-emerald-600 bg-emerald-50/50 dark:bg-emerald-950/40 text-stone-900 dark:text-stone-100' : 'border-rose-300 dark:border-rose-800 bg-rose-50/50 dark:bg-rose-950/40 text-stone-700 dark:text-stone-300'}">
                <div class="flex items-center justify-between">
                  <div>
                    <span class="font-medium text-stone-500 dark:text-stone-400">Your Answer:</span>
                    <span class="ml-1 font-semibold {isCorrect ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}">
                      {userPick || '(No answer provided)'}
                    </span>
                  </div>
                  {#if isCorrect}
                    <span class="text-emerald-600 dark:text-emerald-400 font-semibold text-xs">&#10004; Correct</span>
                  {:else}
                    <span class="text-rose-600 dark:text-rose-400 font-semibold text-xs">&#10008; Incorrect</span>
                  {/if}
                </div>
                {#if !isCorrect}
                  <div class="mt-2 pt-2 border-t border-rose-200 dark:border-rose-900/60 text-xs">
                    <span class="font-medium text-stone-600 dark:text-stone-400">Correct Answer:</span>
                    <span class="ml-1 font-semibold text-emerald-700 dark:text-emerald-300">{q.correctAnswer}</span>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {:else}
          <!-- Multiple Choice Options -->
          <div class="space-y-2">
            {#each q.options as opt}
              {@const isSelected = userPick === opt.letter}
              {@const isOptionCorrect = Boolean(q.correctAnswer) && opt.letter === q.correctAnswer}

              <button
                onclick={() => selectOption(q.number, opt.letter)}
                disabled={submitted}
                class="w-full text-left p-3 rounded-lg border text-xs flex items-start space-x-3 transition cursor-pointer {
                  submitted
                    ? isOptionCorrect
                      ? 'border-emerald-500 dark:border-emerald-600 bg-emerald-50/50 dark:bg-emerald-950/40 font-medium text-stone-900 dark:text-stone-100'
                      : isSelected
                        ? 'border-rose-300 dark:border-rose-800 bg-rose-50/50 dark:bg-rose-950/40 text-stone-700 dark:text-stone-300'
                        : 'border-stone-100 dark:border-stone-800 opacity-60 text-stone-600 dark:text-stone-400'
                    : isSelected
                      ? 'border-stone-900 dark:border-stone-100 bg-stone-900/5 dark:bg-white/10 text-stone-900 dark:text-stone-100 font-medium'
                      : 'border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800/50 text-stone-700 dark:text-stone-300'
                }"
              >
                <div class="w-5 h-5 rounded-full flex items-center justify-center font-mono text-[11px] shrink-0 font-medium {
                  submitted
                    ? isOptionCorrect
                      ? 'bg-emerald-600 text-white'
                      : isSelected
                        ? 'bg-rose-500 text-white'
                        : 'border border-stone-200 dark:border-stone-700 text-stone-500 dark:text-stone-400'
                    : isSelected
                      ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900'
                      : 'border border-stone-300 dark:border-stone-700 text-stone-500 dark:text-stone-400'
                }">
                  {opt.letter}
                </div>
                <div class="leading-relaxed flex-1">
                  {@html mathHtml(opt.text)}
                </div>
              </button>
            {/each}
          </div>
        {/if}

        <!-- Explanation after submit -->
        {#if submitted && q.explanation}
          <div class="mt-3 p-3 rounded-lg bg-stone-50 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-800 text-xs text-stone-700 dark:text-stone-300 flex items-start space-x-2">
            <HelpCircle class="w-4 h-4 text-stone-400 dark:text-stone-500 shrink-0 mt-0.5" />
            <div>
              <span class="font-semibold text-stone-900 dark:text-stone-100">Explanation:</span>
              <span class="ml-1 leading-relaxed">{@html mathHtml(q.explanation)}</span>
            </div>
          </div>
        {/if}
      </div>
    {/each}

    <!-- Submit / Action Footer -->
    <div class="pt-4 pb-8">
      {#if !submitted}
        <div class="flex items-center justify-between">
          <div class="text-xs text-stone-500 dark:text-stone-400">
            {Object.keys(userAnswers).filter(k => (userAnswers[k] || '').trim().length > 0).length} of {totalQuestions} answered
          </div>
          <button
            onclick={() => handleSubmitQuiz(false)}
            disabled={isSubmitting || Object.keys(userAnswers).filter(k => (userAnswers[k] || '').trim().length > 0).length === 0}
            class="flex items-center space-x-1.5 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm cursor-pointer"
          >
            {#if isSubmitting}
              <Loader2 class="w-4 h-4 animate-spin" />
              <span>Sending to Supervisor...</span>
            {:else}
              <Send class="w-3.5 h-3.5" />
              <span>Submit Pop Quiz</span>
            {/if}
          </button>
        </div>
      {:else if isPopQuiz}
        <!-- Unified Green Box: Score, Time & Sent to Teacher, with Mark Lesson Done on bottom-right -->
        <div class="p-4 sm:p-5 rounded-xl border border-emerald-300 dark:border-emerald-700/80 bg-emerald-50/90 dark:bg-emerald-950/60 text-emerald-950 dark:text-emerald-100 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-in fade-in duration-200">
          <div class="space-y-1.5">
            <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span class="text-base font-bold text-emerald-950 dark:text-emerald-50">
                Score: {score} / {totalQuestions} ({percentage}%)
              </span>
              <span class="text-xs text-emerald-800 dark:text-emerald-300 font-medium">
                &bull; Time: {formatDuration(timeSpentSecondsState)}
                {#if timedOutState}
                  <span class="ml-1 text-rose-600 dark:text-rose-400 font-semibold">(5-minute timer expired)</span>
                {/if}
              </span>
            </div>
            <div class="flex items-center space-x-2 text-xs font-medium text-emerald-800 dark:text-emerald-200">
              <CheckCircle2 class="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>{supervisorMessage || 'Updated course supervisor, thank you!'}</span>
            </div>
          </div>

          {#if onMarkLessonDone}
            <div class="sm:self-center shrink-0">
              <button
                type="button"
                onclick={onMarkLessonDone}
                disabled={isMarkingDone}
                class="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-xs font-semibold shadow-sm transition disabled:opacity-50 cursor-pointer"
              >
                {#if isMarkingDone}
                  <Loader2 class="w-4 h-4 animate-spin" />
                  <span>Marking Done...</span>
                {:else}
                  <CheckCircle2 class="w-4 h-4" />
                  <span>Mark Lesson Done</span>
                {/if}
              </button>
            </div>
          {/if}
        </div>
      {:else}
        <div class="text-xs text-stone-500 dark:text-stone-400">
          Quiz completed.
        </div>
      {/if}
    </div>
  </div>
</div>
