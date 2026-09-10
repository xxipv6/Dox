<script setup lang="ts">
import { useSettingsStore } from '../stores/settings'
import { TERMINAL_THEMES } from '../utils/themes'

const settings = useSettingsStore()
</script>

<template>
  <div v-if="settings.dialogVisible" class="overlay" @click.self="settings.dialogVisible = false">
    <div class="dialog">
      <div class="dialog-header">
        <span>设置</span>
        <button class="close-btn" @click="settings.dialogVisible = false">×</button>
      </div>

      <div class="field">
        <label>终端配色方案</label>
        <div class="theme-list">
          <div
            v-for="preset in TERMINAL_THEMES"
            :key="preset.id"
            class="theme-item"
            :class="{ active: settings.themeId === preset.id }"
            @click="settings.themeId = preset.id"
          >
            <span
              class="swatch"
              :style="{
                background: preset.theme.background,
                color: preset.theme.foreground,
                borderColor: preset.theme.selectionBackground
              }"
            >A$</span>
            <span>{{ preset.name }}</span>
          </div>
        </div>
      </div>

      <div class="field">
        <label>终端字号：{{ settings.fontSize }}px</label>
        <input v-model.number="settings.fontSize" type="range" min="10" max="24" step="1" />
      </div>

      <p class="note">UI 整体配色与快捷键自定义在后续版本提供。</p>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  width: 380px;
  background: #16161e;
  border: 1px solid #2a2b3d;
  border-radius: 10px;
  padding: 16px;
}
.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 16px;
}
.close-btn {
  background: none;
  border: none;
  color: #565f89;
  font-size: 18px;
  cursor: pointer;
}
.close-btn:hover {
  color: #c0caf5;
}
.field {
  margin-bottom: 16px;
}
.field label {
  display: block;
  font-size: 12px;
  color: #565f89;
  margin-bottom: 8px;
}
.theme-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.theme-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  font-size: 13px;
  cursor: pointer;
}
.theme-item:hover {
  background: #1f2335;
}
.theme-item.active {
  border-color: #7aa2f7;
  background: #1f2335;
}
.swatch {
  width: 36px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-family: monospace;
  flex-shrink: 0;
}
input[type='range'] {
  width: 100%;
  accent-color: #7aa2f7;
}
.note {
  font-size: 12px;
  color: #565f89;
  margin: 0;
}
</style>
