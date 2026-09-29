<script lang="ts">
  /**
   * Deep-link route for the notes inbox. The inbox itself lives on the Add page (mode: note),
   * because that is where a person already goes to write one. This route is kept, unadvertised,
   * so existing links and the production smoke tests continue to resolve.
   */
  import NotesInbox from '$lib/components/NotesInbox.svelte';
</script>

<NotesInbox />
