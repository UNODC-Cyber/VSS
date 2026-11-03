import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './locales/en';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});
