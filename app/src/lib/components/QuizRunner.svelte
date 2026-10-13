<script lang="ts">
  import { QuestionParser, type ParsedQuiz, type QuizQuestion } from '$lib/parser/questionParser';
  import CodeMirrorEditor from './CodeMirrorEditor.svelte';
  import { CheckCircle2, XCircle, RotateCcw, Edit3, PlayCircle, HelpCircle, Award } from 'lucide-svelte';
  import DOMPurify from 'dompurify';
  import { renderTextWithMath } from '$lib/markdown/mathRenderer';

  interface Props {
    testMarkdown: string;
    onSaveMarkdown?: (newMarkdown: string) => void;
  }

  let { testMarkdown }: Props = $props();

  // Quiz text is plain text with embedded LaTeX (\(...\), $...$): render the math
  // via KaTeX and escape everything else, then sanitize for {@html} injection.
  function mathHtml(text: string): string {
    const rendered = renderTextWithMath(text);
    if (typeof window === 'undefined') return rendered;
    const purify = typeof DOMPurify.sanitize === 'function' ? DOMPurify : (DOMPurify as any)(window);
    if (!purify || typeof purify.sanitize !== 'function') return rendered;
    return purify.sanitize(rendered, { ADD_TAGS: ['details', 'summary', 'mark'] });
  }

  let userAnswers: Record<string, string> = $state({});
  let submitted: boolean = $state(false);

  $effect(() => {
    testMarkdown;
    userAnswers = {};
    submitted = false;
  });

  let parsedQuiz: ParsedQuiz = $derived.by(() => {
    return QuestionParser.parseMarkdown(testMarkdown);
  });

  let totalQuestions = $derived(parsedQuiz.questions.length);

  let score = $derived.by(() => {
    if (!submitted) return 0;
    return parsedQuiz.questions.reduce((acc, q) => {
      return acc + (userAnswers[q.number] === q.correctAnswer ? 1 : 0);
    }, 0);
  });

  let percentage = $derived(
    totalQuestions > 0 ? Math.round((score / totalQuestions) * 100) : 0
  );

  function selectOption(qNum: string, optLetter: string) {
    if (submitted) return; // Prevent changing after submit
    userAnswers[qNum] = optLetter;
  }

  function submitQuiz() {
    submitted = true;
  }

  function resetQuiz() {
    userAnswers = {};
    submitted = false;
  }
</script>

<div class="h-full flex flex-col">
  <!-- Quiz Header -->
  <div class="flex items-center justify-between pb-4 mb-4 border-b border-stone-200 dark:border-stone-800 pr-48 sm:pr-56">
    <div>
      <h2 class="text-base font-semibold text-stone-900 dark:text-stone-100">{parsedQuiz.title}</h2>
      <p class="text-xs text-stone-500 dark:text-stone-400">
        Ontario Curriculum KICA Practice Test • {totalQuestions} Questions
      </p>
    </div>
  </div>
    <!-- Interactive Quiz View -->
    <div class="flex-1 overflow-y-auto space-y-6 pr-2">
      <!-- Score Banner when Submitted -->
      {#if submitted}
        <div class="p-4 rounded-xl border {percentage >= 75 ? 'border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/70 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200' : percentage >= 50 ? 'border-amber-200 dark:border-amber-800/60 bg-amber-50/70 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200' : 'border-rose-200 dark:border-rose-800/60 bg-rose-50/70 dark:bg-rose-950/40 text-rose-900 dark:text-rose-200'} flex items-center justify-between">
          <div class="flex items-center space-x-3">
            <div class="p-2 rounded-lg {percentage >= 75 ? 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300' : percentage >= 50 ? 'bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300' : 'bg-rose-100 dark:bg-rose-900/60 text-rose-700 dark:text-rose-300'}">
              <Award class="w-6 h-6" />
            </div>
            <div>
              <div class="text-sm font-semibold">
                Score: {score} / {totalQuestions} ({percentage}%)
              </div>
              <p class="text-xs opacity-80">
                {#if percentage >= 80}
                  Excellent mastery of Ontario curriculum expectations!
                {:else if percentage >= 60}
                  Solid progress. Review the explanations below for deeper recall.
                {:else}
                  Keep practicing. Refer to the Full Lesson and Summary notes to reinforce these concepts.
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
        {@const isCorrect = userPick === q.correctAnswer}

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

          <!-- Options -->
          <div class="space-y-2">
            {#each q.options as opt}
              {@const isSelected = userPick === opt.letter}
              {@const isOptionCorrect = opt.letter === q.correctAnswer}

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
      <div class="pt-4 pb-8 flex items-center justify-between">
        {#if !submitted}
          <div class="text-xs text-stone-500 dark:text-stone-400">
            {Object.keys(userAnswers).length} of {totalQuestions} answered
          </div>
          <button
            onclick={submitQuiz}
            disabled={Object.keys(userAnswers).length === 0}
            class="px-5 py-2 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm cursor-pointer"
          >
            Submit Practice Test
          </button>
        {:else}
          <div></div>
          <button
            onclick={resetQuiz}
            class="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition shadow-sm cursor-pointer"
          >
            <RotateCcw class="w-3.5 h-3.5" />
            <span>Retake Test</span>
          </button>
        {/if}
      </div>
    </div>
</div>
