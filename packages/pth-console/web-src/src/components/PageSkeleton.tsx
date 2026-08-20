/** Suspense fallback shown while a lazy page chunk loads. */
export function PageSkeleton() {
  return (
    <div class="page-skeleton" aria-busy="true" aria-label="页面加载中">
      <div class="page-skeleton__line page-skeleton__line--title" />
      <div class="page-skeleton__line" />
      <div class="page-skeleton__line" />
      <div class="page-skeleton__block" />
    </div>
  );
}
