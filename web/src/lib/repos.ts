/*
 * Copyright 2026 The Apache Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export const MAVEN_OWNER = 'apache'

export const MAVEN_REPOS: readonly string[] = [
  'maven-site',
  'maven-sources',
  'maven-build-cache-extension',
  'maven',
  'maven-mvnd',
  'maven-integration-testing',
  'maven-resolver',
  'maven-resolver-ant-tasks',
  'maven-wrapper',
  'maven-clean-plugin',
  'maven-compiler-plugin',
  'maven-deploy-plugin',
  'maven-install-plugin',
  'maven-resources-plugin',
  'maven-site-plugin',
  'maven-surefire',
  'maven-verifier-plugin',
  'maven-ear-plugin',
  'maven-ejb-plugin',
  'maven-jar-plugin',
  'maven-rar-plugin',
  'maven-war-plugin',
  'maven-acr-plugin',
  'maven-shade-plugin',
  'maven-source-plugin',
  'maven-jlink-plugin',
  'maven-jmod-plugin',
  'maven-changelog-plugin',
  'maven-changes-plugin',
  'maven-checkstyle-plugin',
  'maven-doap-plugin',
  'maven-javadoc-plugin',
  'maven-jdeps-plugin',
  'maven-jxr',
  'maven-pmd-plugin',
  'maven-project-info-reports-plugin',
  'maven-antrun-plugin',
  'maven-archetype',
  'maven-artifact-plugin',
  'maven-assembly-plugin',
  'maven-dependency-plugin',
  'maven-enforcer',
  'maven-gpg-plugin',
  'maven-help-plugin',
  'maven-invoker-plugin',
  'maven-jarsigner-plugin',
  'maven-jdeprscan-plugin',
  'maven-plugin-tools',
  'maven-release',
  'maven-remote-resources-plugin',
  'maven-scm',
  'maven-scm-publish-plugin',
  'maven-scripting-plugin',
  'maven-stage-plugin',
  'maven-toolchains-plugin',
  'maven-archiver',
  'maven-artifact-transfer',
  'maven-common-artifact-filters',
  'maven-dependency-analyzer',
  'maven-dependency-tree',
  'maven-file-management',
  'maven-filtering',
  'maven-invoker',
  'maven-jarsigner',
  'maven-mapping',
  'maven-project-utils',
  'maven-reporting-api',
  'maven-reporting-exec',
  'maven-reporting-impl',
  'maven-script-interpreter',
  'maven-shared-incremental',
  'maven-shared-io',
  'maven-shared-jar',
  'maven-shared-resources',
  'maven-shared-utils',
  'maven-verifier',
  'maven-doxia',
  'maven-doxia-site',
  'maven-doxia-sitetools',
  'maven-doxia-book-maven-plugin',
  'maven-doxia-book-renderer',
  'maven-doxia-converter',
  'maven-doxia-linkcheck',
  'maven-archetypes',
  'maven-parent',
  'maven-apache-parent',
  'maven-apache-resources',
  'maven-fluido-skin',
  'maven-dist-tool',
  'maven-gh-actions-shared',
  'maven-jenkins-env',
  'maven-jenkins-lib',
  'maven-indexer',
  'maven-plugin-testing',
  'maven-wagon',
  'maven-studies',
  'maven-repository-tools',
  'maven-doxia-ide',
]

export const PLEXUS_OWNER = 'codehaus-plexus'

export const PLEXUS_REPOS: readonly string[] = [
  'codehaus-plexus.github.io',
  'modello',
  'plexus-archiver',
  'plexus-build-api',
  'plexus-classworlds',
  'plexus-compiler',
  'plexus-i18n',
  'plexus-interactivity',
  'plexus-interpolation',
  'plexus-io',
  'plexus-languages',
  'plexus-pom',
  'plexus-resources',
  'plexus-sec-dispatcher',
  'plexus-testing',
  'plexus-utils',
  'plexus-velocity',
  'plexus-xml',
]

export const MOJOHAUS_OWNER = 'mojohaus'

export const MOJOHAUS_REPOS: readonly string[] = [
  'animal-sniffer',
  'aspectj-maven-plugin',
  'build-helper-maven-plugin',
  'buildnumber-maven-plugin',
  'buildplan-maven-plugin',
  'clirr-maven-plugin',
  'cobertura-maven-plugin',
  'exec-maven-plugin',
  'extra-enforcer-rules',
  'flatten-maven-plugin',
  'javacc-maven-plugin',
  'javancss-maven-plugin',
  'jaxb2-maven-plugin',
  'jaxws-maven-plugin',
  'jboss-packaging-maven-plugin',
  'jdepend-maven-plugin',
  'jdiff-maven-plugin',
  'keytool',
  'l10n-maven-plugin',
  'license-maven-plugin',
  'maven-native',
  'mojo-parent',
  'mojohaus.github.io',
  'mrm',
  'native2ascii-maven-plugin',
  'osgi-archetype',
  'properties-maven-plugin',
  'reproducible-mojohaus',
  'rpm-maven-plugin',
  'servicedocgen-maven-plugin',
  'signatures',
  'siteskinner-maven-plugin',
  'taglist-maven-plugin',
  'templating-maven-plugin',
  'tidy-maven-plugin',
  'truezip',
  'versions',
  'wagon-maven-plugin',
  'webstart',
  'workflow-test',
  'xml-maven-plugin',
]

/**
 * Every repository the dashboard sweeps, in owner order: apache first, then
 * the Plexus and MojoHaus components Maven builds on.
 */
export const ALL_REPOS: readonly string[] = [...MAVEN_REPOS, ...PLEXUS_REPOS, ...MOJOHAUS_REPOS]

const OWNER_BY_REPO: ReadonlyMap<string, string> = new Map([
  ...MAVEN_REPOS.map((r) => [r, MAVEN_OWNER] as const),
  ...PLEXUS_REPOS.map((r) => [r, PLEXUS_OWNER] as const),
  ...MOJOHAUS_REPOS.map((r) => [r, MOJOHAUS_OWNER] as const),
])

/**
 * Repository names are the identity used for cache keys and result objects, so
 * the owner is looked up rather than carried alongside. Names are unique across
 * the three organisations — `repos.test.ts` holds that line. An unknown name
 * falls back to `apache`, which is what a hand-typed repo is most likely to be.
 */
export function ownerOf(repo: string): string {
  return OWNER_BY_REPO.get(repo) ?? MAVEN_OWNER
}
