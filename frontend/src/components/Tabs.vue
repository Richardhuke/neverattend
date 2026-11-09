<script setup>
defineProps({
  modelValue: { type: String, default: '' },
  items: { type: Array, required: true }
})
const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <div class="tabs" role="tablist">
    <button
      v-for="it in items"
      :key="it.value"
      class="tab"
      role="tab"
      :class="{ active: modelValue === it.value }"
      :aria-selected="modelValue === it.value"
      @click="emit('update:modelValue', it.value)"
    >
      <span v-if="it.icon" class="mono" style="opacity: .7">{{ it.icon }}</span>{{ it.label }}
    </button>
  </div>
</template>
