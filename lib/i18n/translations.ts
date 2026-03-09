export type Lang = "en" | "es";

export type TranslationKey =
  // Nav
  | "nav.explore"
  | "nav.calendar"
  | "nav.compare"
  | "nav.saved"
  | "nav.signIn"
  | "nav.signOut"
  | "nav.myDashboard"
  | "nav.adminPortal"
  | "nav.exploreCamps"
  | "nav.weeklyCalendar"
  | "nav.compareCamps"
  | "nav.savedCamps"
  | "nav.signedInAs"
  | "nav.theme"
  // Filters
  | "filters.allAges"
  | "filters.categories"
  | "filters.campType"
  | "filters.neighborhood"
  | "filters.costRange"
  | "filters.week"
  | "filters.clearFilters"
  | "filters.apply"
  | "filters.filters"
  | "filters.showFilters"
  | "filters.hideFilters"
  // Camp card
  | "card.register"
  | "card.save"
  | "card.saved"
  | "card.ages"
  | "card.available"
  | "card.sessions"
  | "card.openingSoon"
  | "card.comingSoon"
  | "card.opens"
  | "card.weeksAvailable"
  | "card.contactForSchedule"
  | "card.contactForPricing"
  | "card.total"
  | "card.perSession"
  | "card.perWeek"
  | "card.lunch"
  | "card.earlyDropOff"
  | "card.removeSaved"
  | "card.saveCamp"
  // Camp detail
  | "detail.overview"
  | "detail.schedule"
  | "detail.pricing"
  | "detail.ageGroups"
  | "detail.location"
  | "detail.hours"
  | "detail.registerNow"
  | "detail.saveCamp"
  | "detail.website"
  | "detail.contactForPricing"
  | "detail.noSchedules"
  | "detail.lunchIncluded"
  | "detail.earlyDropOff"
  | "detail.shareCalendar"
  | "detail.addToCalendar"
  // Dashboard
  | "dashboard.mySavedCamps"
  | "dashboard.noSavedCamps"
  | "dashboard.notifications"
  | "dashboard.browseCamps"
  | "dashboard.signInToSave"
  | "dashboard.manageAlerts"
  // Common
  | "common.loading"
  | "common.error"
  | "common.searchCamps"
  | "common.viewDetails"
  | "common.back"
  | "common.learnMore"
  | "common.close"
  | "common.open"
  | "common.yes"
  | "common.no"
  | "common.or"
  | "common.and"
  | "common.free"
  | "common.contactUs"
  | "common.noResults"
  | "common.tryAdjusting";

const en: Record<TranslationKey, string> = {
  // Nav
  "nav.explore": "Explore",
  "nav.calendar": "Calendar",
  "nav.compare": "Compare",
  "nav.saved": "Saved",
  "nav.signIn": "Sign In",
  "nav.signOut": "Sign Out",
  "nav.myDashboard": "My Dashboard",
  "nav.adminPortal": "Admin Portal",
  "nav.exploreCamps": "Explore Camps",
  "nav.weeklyCalendar": "Weekly Calendar",
  "nav.compareCamps": "Compare Camps",
  "nav.savedCamps": "Saved Camps",
  "nav.signedInAs": "Signed in as",
  "nav.theme": "Theme",
  // Filters
  "filters.allAges": "All Ages",
  "filters.categories": "Categories",
  "filters.campType": "Camp Type",
  "filters.neighborhood": "Neighborhood",
  "filters.costRange": "Cost Range",
  "filters.week": "Week",
  "filters.clearFilters": "Clear Filters",
  "filters.apply": "Apply",
  "filters.filters": "Filters",
  "filters.showFilters": "Show Filters",
  "filters.hideFilters": "Hide Filters",
  // Camp card
  "card.register": "Register",
  "card.save": "Save",
  "card.saved": "Saved",
  "card.ages": "Ages",
  "card.available": "Available",
  "card.sessions": "Sessions",
  "card.openingSoon": "Opening Soon",
  "card.comingSoon": "Coming Soon",
  "card.opens": "Opens",
  "card.weeksAvailable": "weeks available",
  "card.contactForSchedule": "Contact for schedule",
  "card.contactForPricing": "Contact for pricing",
  "card.total": "total",
  "card.perSession": "/session",
  "card.perWeek": "/week",
  "card.lunch": "Lunch",
  "card.earlyDropOff": "Early drop-off",
  "card.removeSaved": "Remove from saved",
  "card.saveCamp": "Save camp",
  // Camp detail
  "detail.overview": "Overview",
  "detail.schedule": "Schedule",
  "detail.pricing": "Pricing",
  "detail.ageGroups": "Age Groups",
  "detail.location": "Location",
  "detail.hours": "Hours",
  "detail.registerNow": "Register Now",
  "detail.saveCamp": "Save Camp",
  "detail.website": "Website",
  "detail.contactForPricing": "Contact for pricing",
  "detail.noSchedules": "No schedules available",
  "detail.lunchIncluded": "Lunch Included",
  "detail.earlyDropOff": "Early Drop-off Available",
  "detail.shareCalendar": "Share Calendar",
  "detail.addToCalendar": "Add to Calendar",
  // Dashboard
  "dashboard.mySavedCamps": "My Saved Camps",
  "dashboard.noSavedCamps": "No saved camps yet",
  "dashboard.notifications": "Notifications",
  "dashboard.browseCamps": "Browse Camps",
  "dashboard.signInToSave": "Sign in to save camps",
  "dashboard.manageAlerts": "Manage Alerts",
  // Common
  "common.loading": "Loading...",
  "common.error": "Something went wrong",
  "common.searchCamps": "Search camps...",
  "common.viewDetails": "View Details",
  "common.back": "Back",
  "common.learnMore": "Learn More",
  "common.close": "Close",
  "common.open": "Open",
  "common.yes": "Yes",
  "common.no": "No",
  "common.or": "or",
  "common.and": "and",
  "common.free": "Free",
  "common.contactUs": "Contact Us",
  "common.noResults": "No camps found",
  "common.tryAdjusting": "Try adjusting your filters",
};

const es: Record<TranslationKey, string> = {
  // Nav
  "nav.explore": "Explorar",
  "nav.calendar": "Calendario",
  "nav.compare": "Comparar",
  "nav.saved": "Guardados",
  "nav.signIn": "Iniciar sesión",
  "nav.signOut": "Cerrar sesión",
  "nav.myDashboard": "Mi panel",
  "nav.adminPortal": "Portal de administración",
  "nav.exploreCamps": "Explorar campamentos",
  "nav.weeklyCalendar": "Calendario semanal",
  "nav.compareCamps": "Comparar campamentos",
  "nav.savedCamps": "Campamentos guardados",
  "nav.signedInAs": "Sesión iniciada como",
  "nav.theme": "Tema",
  // Filters
  "filters.allAges": "Todas las edades",
  "filters.categories": "Categorías",
  "filters.campType": "Tipo de campamento",
  "filters.neighborhood": "Vecindario",
  "filters.costRange": "Rango de costo",
  "filters.week": "Semana",
  "filters.clearFilters": "Limpiar filtros",
  "filters.apply": "Aplicar",
  "filters.filters": "Filtros",
  "filters.showFilters": "Mostrar filtros",
  "filters.hideFilters": "Ocultar filtros",
  // Camp card
  "card.register": "Registrarse",
  "card.save": "Guardar",
  "card.saved": "Guardado",
  "card.ages": "Edades",
  "card.available": "Disponible",
  "card.sessions": "Sesiones",
  "card.openingSoon": "Abriendo pronto",
  "card.comingSoon": "Próximamente",
  "card.opens": "Abre",
  "card.weeksAvailable": "semanas disponibles",
  "card.contactForSchedule": "Contactar para horario",
  "card.contactForPricing": "Contactar para precios",
  "card.total": "total",
  "card.perSession": "/sesión",
  "card.perWeek": "/semana",
  "card.lunch": "Almuerzo",
  "card.earlyDropOff": "Entrega temprana",
  "card.removeSaved": "Quitar de guardados",
  "card.saveCamp": "Guardar campamento",
  // Camp detail
  "detail.overview": "Descripción",
  "detail.schedule": "Horario",
  "detail.pricing": "Precios",
  "detail.ageGroups": "Grupos de edad",
  "detail.location": "Ubicación",
  "detail.hours": "Horas",
  "detail.registerNow": "Registrarse ahora",
  "detail.saveCamp": "Guardar campamento",
  "detail.website": "Sitio web",
  "detail.contactForPricing": "Contactar para precios",
  "detail.noSchedules": "No hay horarios disponibles",
  "detail.lunchIncluded": "Almuerzo incluido",
  "detail.earlyDropOff": "Entrega temprana disponible",
  "detail.shareCalendar": "Compartir calendario",
  "detail.addToCalendar": "Agregar al calendario",
  // Dashboard
  "dashboard.mySavedCamps": "Mis campamentos guardados",
  "dashboard.noSavedCamps": "Aún no hay campamentos guardados",
  "dashboard.notifications": "Notificaciones",
  "dashboard.browseCamps": "Explorar campamentos",
  "dashboard.signInToSave": "Inicia sesión para guardar campamentos",
  "dashboard.manageAlerts": "Gestionar alertas",
  // Common
  "common.loading": "Cargando...",
  "common.error": "Algo salió mal",
  "common.searchCamps": "Buscar campamentos...",
  "common.viewDetails": "Ver detalles",
  "common.back": "Volver",
  "common.learnMore": "Saber más",
  "common.close": "Cerrar",
  "common.open": "Abrir",
  "common.yes": "Sí",
  "common.no": "No",
  "common.or": "o",
  "common.and": "y",
  "common.free": "Gratis",
  "common.contactUs": "Contáctenos",
  "common.noResults": "No se encontraron campamentos",
  "common.tryAdjusting": "Intenta ajustar los filtros",
};

export const translations: Record<Lang, Record<TranslationKey, string>> = { en, es };
