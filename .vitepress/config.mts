import { defineConfig } from 'vitepress'

const base = process.env.BASE_PATH || '/'

export default defineConfig({
  title: 'MVZ443 文档',
  description: 'MVZ443 游戏文档与更新日志',
  base,
  ignoreDeadLinks: true,
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: '更新日志', link: '/update-logs/' },
      { text: '游戏文档', link: '/game-docs/' }
    ],
    sidebar: [
      {
        text: '更新日志',
        link: '/update-logs/',
      },
      {
        text: '游戏文档',
        link: '/game-docs/',
        items: [
          { text: '联机教程', link: '/game-docs/online_turtorial' },
          { text: '第一章怪物情报', link: '/game-docs/chapter1edx' },
          { text: '存档系统使用指南', link: '/game-docs/save_system_guide' },
          { text: '植物系统重构指南', link: '/game-docs/PLANT_REFACTOR_GUIDE' },
          { text: '重制计划', link: '/game-docs/milestone/01-overhaul' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/' }
    ],
    outline: {
      label: '页面目录'
    },
    docFooter: {
      prev: '上一页',
      next: '下一页'
    },
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '返回顶部'
  }
})
