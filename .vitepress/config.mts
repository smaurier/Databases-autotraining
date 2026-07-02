import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'PostgreSQL & Databases Course',
  description: 'Formation complète PostgreSQL & Databases : indexes, query planner, locks, isolation, MVCC, JSONB (débutant → expert)',
  lang: 'fr-FR',
  srcDir: '.',

  // Docs statiques : neutralise l'interpolation Vue `{{ }}` (délimiteurs improbables) pour que
  // les moustaches en prose et les expressions `${{ }}` (GitHub Actions) ne cassent pas le SSR.
  vue: {
    template: {
      compilerOptions: {
        delimiters: ['(%(', ')%)'],
      },
    },
  },

  // Cohérent avec les autres cours refonte : on n'échoue pas le build sur des liens internes
  // (les labs se cross-référencent, renumérotation en cours). L'intégrité prereq/next des
  // modules est enforcée séparément par gate-course.ps1.
  ignoreDeadLinks: true,

  themeConfig: {
    nav: [
      { text: 'Modules', link: '/modules/00-prerequis-et-vue-ensemble' },
      { text: 'Labs', link: '/labs/lab-01-premiers-pas-psql/README' },
      { text: 'Quizzes', link: '/quizzes/' },
      { text: 'Visualisations', link: '/visualizations/' },
      { text: 'Glossaire', link: '/glossaire' }
    ],

    sidebar: {
      '/modules/': [
        {
          text: 'Modules',
          items: [
            { text: '00 — Prérequis & Vue d\'ensemble', link: '/modules/00-prerequis-et-vue-ensemble' },
            { text: '01 — Le modèle relationnel', link: '/modules/01-modele-relationnel' },
            { text: '02 — CRUD & Requêtes SQL', link: '/modules/02-crud-et-requetes' },
            { text: '03 — Relations & Jointures', link: '/modules/03-relations-et-jointures' },
            { text: '04 — Transactions & ACID', link: '/modules/04-transactions-et-acid' },
            { text: '05 — Index : les fondamentaux', link: '/modules/05-index-fondamentaux' },
            { text: '06 — Le Query Planner', link: '/modules/06-query-planner' },
            { text: '07 — Index avancés', link: '/modules/07-index-avances' },
            { text: '08 — Niveaux d\'isolation & MVCC', link: '/modules/08-niveaux-isolation' },
            { text: '09 — Verrous & Locks', link: '/modules/09-verrous-et-locks' },
            { text: '10 — Deadlocks', link: '/modules/10-deadlocks' },
            { text: '11 — Performances & Optimisation', link: '/modules/11-performances-et-optimisation' },
            { text: '12 — Fonctions avancées SQL', link: '/modules/12-fonctions-avancees-sql' },
            { text: '13 — JSONB & Types avancés', link: '/modules/13-jsonb-et-types-avances' },
            { text: '14 — Sécurité & Administration', link: '/modules/14-securite-et-administration' },
            { text: '15 — Projet final', link: '/modules/15-projet-final' },
            { text: '16 — Réplication', link: '/modules/16-replication' },
            { text: '17 — Monitoring & Observabilité', link: '/modules/17-monitoring-et-observabilite' },
            { text: '18 — Partitioning & Scaling', link: '/modules/18-partitioning-et-scaling' },
            { text: '19 - pgvector & Embeddings', link: '/modules/19-pgvector-embeddings' }
          ]
        }
      ],
      '/quizzes/': [
        {
          text: 'Quizzes',
          items: [
            { text: 'Tous les quizzes', link: '/quizzes/' },
            { text: 'Quiz 00 — Prérequis', link: '/quizzes/quiz-00-prerequis' },
            { text: 'Quiz 01 — Modèle relationnel', link: '/quizzes/quiz-01-modele-relationnel' },
            { text: 'Quiz 02 — CRUD & SQL', link: '/quizzes/quiz-02-crud-sql' },
            { text: 'Quiz 03 — Jointures', link: '/quizzes/quiz-03-jointures' },
            { text: 'Quiz 04 — Transactions', link: '/quizzes/quiz-04-transactions' },
            { text: 'Quiz 05 — Index', link: '/quizzes/quiz-05-index' },
            { text: 'Quiz 06 — Query Planner', link: '/quizzes/quiz-06-query-planner' },
            { text: 'Quiz 07 — Index avancés', link: '/quizzes/quiz-07-index-avances' },
            { text: 'Quiz 08 — Isolation & MVCC', link: '/quizzes/quiz-08-isolation-mvcc' },
            { text: 'Quiz 09 — Locks', link: '/quizzes/quiz-09-locks' },
            { text: 'Quiz 10 — Deadlocks', link: '/quizzes/quiz-10-deadlocks' },
            { text: 'Quiz 11 — Performances', link: '/quizzes/quiz-11-performances' },
            { text: 'Quiz 12 — Fonctions avancées', link: '/quizzes/quiz-12-fonctions-avancees' },
            { text: 'Quiz 13 — JSONB & Full-Text', link: '/quizzes/quiz-13-jsonb-fulltext' },
            { text: 'Quiz 14 — Sécurité', link: '/quizzes/quiz-14-securite' },
            { text: 'Quiz 15 — Projet final', link: '/quizzes/quiz-15-projet-final' },
            { text: 'Quiz 16 — Réplication', link: '/quizzes/quiz-16-replication' },
            { text: 'Quiz 17 — Monitoring', link: '/quizzes/quiz-17-monitoring' },
            { text: 'Quiz 18 — Partitioning', link: '/quizzes/quiz-18-partitioning' }
          ]
        }
      ],
      '/visualizations/': [
        {
          text: 'Visualisations',
          items: [
            { text: 'Toutes les visualisations', link: '/visualizations/' },
            { text: 'B-tree Index', link: '/visualizations/btree-index.html' },
            { text: 'Query Planner', link: '/visualizations/query-planner.html' },
            { text: 'MVCC & Isolation', link: '/visualizations/mvcc-isolation.html' },
            { text: 'Lock Matrix', link: '/visualizations/lock-matrix.html' },
            { text: 'WAL & Transaction', link: '/visualizations/wal-transaction.html' }
          ]
        }
      ]
    },

    search: {
      provider: 'local'
    },

    outline: {
      level: [2, 3],
      label: 'Sur cette page'
    },

    docFooter: {
      prev: 'Précédent',
      next: 'Suivant'
    }
  }
})
