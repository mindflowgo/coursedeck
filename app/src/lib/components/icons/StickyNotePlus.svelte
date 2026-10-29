<script lang="ts">
  interface Props {
    class?: string;
    size?: number | string;
    strokeWidth?: number | string;
  }

  let { class: className = 'w-4 h-4', size = 24, strokeWidth = 2 }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
>
  <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z" />
  <path d="M15 3v4a2 2 0 0 0 2 2h4" />
  <path d="M8 13h6" />
  <path d="M11 10v6" />
</svg>
