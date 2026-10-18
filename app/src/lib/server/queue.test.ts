import { describe, it, expect } from 'bun:test';
import { GenerationQueue, type GenerationTask } from './queue';

// Subclass GenerationQueue to mock executeTask and avoid hitting real LLM / filesystem
class TestGenerationQueue extends GenerationQueue {
  public executedTasks: GenerationTask[] = [];
  public concurrentWorkersDetected = 0;
  private currentActive = 0;
  public taskDelayMs = 15;
  public failNextTask = false;

  protected override async executeTask(nextTask: GenerationTask): Promise<void> {
    this.currentActive++;
    if (this.currentActive > 1) {
      this.concurrentWorkersDetected++;
    }

    try {
      if (this.taskDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.taskDelayMs));
      }

      if (this.failNextTask) {
        this.failNextTask = false;
        throw new Error('Simulated task execution failure');
      }

      this.executedTasks.push({ ...nextTask });
      nextTask.status = 'completed';
      nextTask.completedAt = new Date().toISOString();
    } finally {
      this.currentActive--;
    }
  }
}

describe('GenerationQueue sequential processor', () => {
  it('executes tasks sequentially in order without concurrency', async () => {
    const queue = new TestGenerationQueue();

    queue.enqueue([
      { courseId: 'test1', lessonId: 'l1', tab: 'summary' },
      { courseId: 'test1', lessonId: 'l2', tab: 'summary' },
      { courseId: 'test1', lessonId: 'l3', tab: 'summary' }
    ]);

    // Wait until all tasks complete
    while (queue.getStatus().pendingCount > 0 || queue.getStatus().isRunning) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const status = queue.getStatus('test1');
    expect(status.completedCount).toBe(3);
    expect(status.failedCount).toBe(0);
    expect(status.pendingCount).toBe(0);
    expect(queue.concurrentWorkersDetected).toBe(0);
    expect(queue.executedTasks.map((t) => t.lessonId)).toEqual(['l1', 'l2', 'l3']);
  });

  it('handles concurrent enqueue calls while active without dropping tasks or duplicate workers', async () => {
    const queue = new TestGenerationQueue();
    queue.taskDelayMs = 30;

    // Enqueue initial task
    queue.enqueue([{ courseId: 'test2', lessonId: 'l1', tab: 'summary' }]);

    // While task 1 is processing, enqueue more tasks concurrently
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.getStatus().isRunning).toBe(true);

    queue.enqueue([
      { courseId: 'test2', lessonId: 'l2', tab: 'summary' },
      { courseId: 'test2', lessonId: 'l3', tab: 'summary' }
    ]);

    while (queue.getStatus().pendingCount > 0 || queue.getStatus().isRunning) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const status = queue.getStatus('test2');
    expect(status.completedCount).toBe(3);
    expect(queue.concurrentWorkersDetected).toBe(0);
    expect(queue.executedTasks.map((t) => t.lessonId)).toEqual(['l1', 'l2', 'l3']);
  });

  it('pauses and resumes queue cleanly', async () => {
    const queue = new TestGenerationQueue();
    queue.taskDelayMs = 25;

    queue.enqueue([
      { courseId: 'test3', lessonId: 'l1', tab: 'summary' },
      { courseId: 'test3', lessonId: 'l2', tab: 'summary' },
      { courseId: 'test3', lessonId: 'l3', tab: 'summary' }
    ]);

    // Pause while l1 is in flight
    await new Promise((r) => setTimeout(r, 10));
    queue.pause();
    expect(queue.getStatus().isPaused).toBe(true);

    // Wait for in-flight task to finish
    while (queue.getStatus().isRunning) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Only l1 should have finished; l2 and l3 remain pending
    expect(queue.executedTasks.length).toBe(1);
    expect(queue.getStatus().pendingCount).toBe(2);

    // Resume
    queue.resume();
    expect(queue.getStatus().isPaused).toBe(false);

    while (queue.getStatus().pendingCount > 0 || queue.getStatus().isRunning) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(queue.getStatus().completedCount).toBe(3);
    expect(queue.executedTasks.map((t) => t.lessonId)).toEqual(['l1', 'l2', 'l3']);
    expect(queue.concurrentWorkersDetected).toBe(0);
  });

  it('rapid pause and resume while task is active does not spawn a second worker', async () => {
    const queue = new TestGenerationQueue();
    queue.taskDelayMs = 40;

    queue.enqueue([
      { courseId: 'test4', lessonId: 'l1', tab: 'summary' },
      { courseId: 'test4', lessonId: 'l2', tab: 'summary' }
    ]);

    // While l1 is active, rapidly pause then resume
    await new Promise((r) => setTimeout(r, 10));
    queue.pause();
    queue.resume();

    while (queue.getStatus().pendingCount > 0 || queue.getStatus().isRunning) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(queue.concurrentWorkersDetected).toBe(0);
    expect(queue.getStatus().completedCount).toBe(2);
  });

  it('continues processing subsequent tasks when one task fails', async () => {
    const queue = new TestGenerationQueue();
    queue.taskDelayMs = 15;

    queue.enqueue([
      { courseId: 'test5', lessonId: 'l1', tab: 'summary' },
      { courseId: 'test5', lessonId: 'l2', tab: 'summary' },
      { courseId: 'test5', lessonId: 'l3', tab: 'summary' }
    ]);

    // Make l2 fail
    queue.failNextTask = false;
    // Wait until l1 completes
    while (queue.executedTasks.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Now trigger failure for next task (l2)
    queue.failNextTask = true;

    while (queue.getStatus().pendingCount > 0 || queue.getStatus().isRunning) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const status = queue.getStatus('test5');
    expect(status.completedCount).toBe(2);
    expect(status.failedCount).toBe(1);
    expect(queue.executedTasks.map((t) => t.lessonId)).toEqual(['l1', 'l3']);

    // Now test retryFailed
    queue.retryFailed('test5');
    while (queue.getStatus().pendingCount > 0 || queue.getStatus().isRunning) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const updatedStatus = queue.getStatus('test5');
    expect(updatedStatus.completedCount).toBe(3);
    expect(updatedStatus.failedCount).toBe(0);
  });

  it('cancels pending tasks cleanly', async () => {
    const queue = new TestGenerationQueue();
    queue.taskDelayMs = 30;

    queue.enqueue([
      { courseId: 'test6', lessonId: 'l1', tab: 'summary' },
      { courseId: 'test6', lessonId: 'l2', tab: 'summary' },
      { courseId: 'test6', lessonId: 'l3', tab: 'summary' }
    ]);

    // While l1 is running, cancel remaining tasks
    await new Promise((r) => setTimeout(r, 10));
    queue.cancelAll('test6');

    while (queue.getStatus().isRunning) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const status = queue.getStatus('test6');
    expect(status.completedCount).toBe(1);
    expect(status.pendingCount).toBe(0);
    expect(queue.executedTasks.map((t) => t.lessonId)).toEqual(['l1']);
  });
});
