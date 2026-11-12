import { createRouter, createWebHashHistory } from 'vue-router'
import Index from '../pages/index.vue'
import About from '../pages/about.vue'
import Config from '../pages/config.vue'
import FirstTime from '../pages/first-time.vue'
import Manage from '../pages/manage.vue'
import Queue from '../pages/queue.vue'

const routes = [
  { path: '/', name: '/', component: Index },
  { path: '/about', name: 'about', component: About },
  { path: '/config', name: 'config', component: Config },
  { path: '/first-time', name: 'first-time', component: FirstTime },
  { path: '/manage', name: 'manage', component: Manage },
  { path: '/queue', name: 'queue', component: Queue },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

export default createRouter({
  history: createWebHashHistory('./'),
  routes
})
