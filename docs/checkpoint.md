# Checkpoint

Create a new tab beside 'Courses' at teh top. It will route to a new /checkpoint route.

The idea behind checkpoint is really a way to track bookmarked pages (and the areas on the page) along with 'post-it' style notes at those points.

The checkpoints allow colors to mark the points with post-it notes (12 noticeable color dots with pastel sticky backgrounds).

Standard icon: `FlagTriangleRight` from `lucide-svelte`.

## Checkpoint Structure
The checkpoint tracks:
- file ex (01.01.lesson.md)
- vertical position in the file
- type: [note|position]
- color
- note text
- date of last change

Each course should have a checkpoint.json file in it with an array of the checkpoints. 

### Checkpoints Route Page (`/checkpoints`)
The checkpoints page features:
1. **Search & Color Bar**: First at the top, a search bar with real-time text filtering and color palette filter buttons.
2. **Course Cards Layout (like `/schedule`)**: Below the search bar, courses are organized alphabetically into responsive cards (`grid gap-4 sm:grid-cols-2`).
3. **Card Checkpoint Items**:
   - Color-dot representing the note color.
   - Part of the written text in a small font (`text-xs truncate`).
   - Do NOT include date strings in the item rows.
   - Strictly ordered by date from most recent to oldest.
   - Scrollable container (`max-h-60 overflow-y-auto`) when a course has many items.
4. **Deep-linking**: Clicking on an item opens that document, scrolls with a 60px breathing offset to that position, and opens the post-it note. Hovering provides a quick delete option.

### Creating Checkpoints
Type = position: When moving up and down a page, we debounce, but record the last position in a checkpoint for that file (type=position).

Type = note: To the right of the page where the cursor is a subtle [+(note-icon)]. Clicking on it opens a modal to create a checkpoint note there.

Afterwards that color dot with a subtle grey-date (of last change) will sit at that point on the page. Clicking on it will open the note.
