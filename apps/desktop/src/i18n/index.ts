import i18n, { use } from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import it from './it.json'
import ru from './ru.json'
import zh from './zh.json'

void use(initReactI18next).init({
  resources: {
    en: { translation: en },
    it: { translation: it },
    zh: { translation: zh },
    ru: { translation: ru },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export default i18n
