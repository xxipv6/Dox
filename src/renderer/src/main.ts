import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useSettingsStore } from './stores/settings'
import './styles.css'

const pinia = createPinia()
const app = createApp(App).use(pinia)

// 先取回设置再挂载：组件在渲染时就会读字号/配色，晚一拍会让用户看到
// 「先闪一下默认主题、再变回自己的主题」。load() 内部对卡顿有兜底。
await useSettingsStore(pinia).load()

app.mount('#app')
