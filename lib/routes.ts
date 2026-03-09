export const routes = {
  home: () => `/`,
  community: (c: string) => `/c/${c}`,
  communityCalendar: (c: string) => `/c/${c}/calendar`,
  communityCompare: (c: string, camps?: string[]) =>
    camps?.length ? `/c/${c}/compare?camps=${camps.join(",")}` : `/c/${c}/compare`,
  campDetail: (c: string, slug: string) => `/c/${c}/camps/${slug}`,
  campCalendarApi: (slug: string) => `/api/camps/${slug}/calendar`,
};
