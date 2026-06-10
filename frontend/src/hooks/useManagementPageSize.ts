import { useLayoutEffect, useState } from "react";

interface ManagementPageSizeOptions {
  cardSelector: string;
  fallbackRowHeight: number;
  totalItems: number;
}

const fallbackPaginationHeight = 44;
const fallbackHeaderHeight = 47;

export function useManagementPageSize({
  cardSelector,
  fallbackRowHeight,
  totalItems
}: ManagementPageSizeOptions): number {
  const [pageSize, setPageSize] = useState(8);

  useLayoutEffect(() => {
    const card = document.querySelector<HTMLElement>(cardSelector);
    const tableWrapper = card?.querySelector<HTMLElement>(".ant-table-wrapper");
    if (!card || !tableWrapper) {
      return;
    }

    let animationFrame = 0;

    const calculatePageSize = () => {
      const wrapperHeight = tableWrapper.getBoundingClientRect().height;
      const headerHeight =
        tableWrapper.querySelector<HTMLElement>(".ant-table-thead")?.getBoundingClientRect().height ||
        fallbackHeaderHeight;
      const rowHeight =
        tableWrapper
          .querySelector<HTMLElement>(
            ".ant-table-tbody > tr:not(.ant-table-measure-row):not(.ant-table-placeholder)"
          )
          ?.getBoundingClientRect().height || fallbackRowHeight;
      const paginationHeight =
        tableWrapper.querySelector<HTMLElement>(".ant-table-pagination")?.getBoundingClientRect().height ||
        fallbackPaginationHeight;
      const horizontalScrollbar = tableWrapper.querySelector<HTMLElement>(".ant-table-content");
      const scrollbarHeight = horizontalScrollbar &&
        horizontalScrollbar.scrollWidth > horizontalScrollbar.clientWidth
        ? 10
        : 0;
      const usableHeight = Math.max(0, wrapperHeight - headerHeight - scrollbarHeight);
      const capacityWithoutPagination = Math.max(1, Math.floor(usableHeight / rowHeight));
      const nextPageSize = totalItems <= capacityWithoutPagination
        ? capacityWithoutPagination
        : Math.max(1, Math.floor((usableHeight - paginationHeight) / rowHeight));

      setPageSize((current) => current === nextPageSize ? current : nextPageSize);
    };

    const scheduleCalculation = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(calculatePageSize);
    };

    const resizeObserver = new ResizeObserver(scheduleCalculation);
    resizeObserver.observe(card);
    resizeObserver.observe(tableWrapper);

    const mutationObserver = new MutationObserver(scheduleCalculation);
    mutationObserver.observe(tableWrapper, { childList: true, subtree: true });

    scheduleCalculation();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [cardSelector, fallbackRowHeight, totalItems]);

  return pageSize;
}
