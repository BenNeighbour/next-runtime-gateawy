import type { NetlifyConfig } from '@netlify/build'
import { copySync, readJSONSync } from 'fs-extra'

import { FUNCTIONS_INTERNAL_DIR, FUNCTIONS_URL } from './constants.js'

const HANDLER_NAME = '___netlify-handler'
const HANDLER_DIR = `${FUNCTIONS_INTERNAL_DIR}/${HANDLER_NAME}`
const HANDLER_URL = `${FUNCTIONS_URL}/${HANDLER_NAME}`

const moveServerFiles = (publishDir: string) => {
  // TODO: consider caching here to avoid copying on every build
  // TODO: consider basepaths and monorepos, etc.
  copySync(`${publishDir}/standalone/.next`, `${HANDLER_DIR}/.next`, { overwrite: true })
  copySync(`${__dirname}/../templates/handler.js`, `${HANDLER_DIR}/${HANDLER_NAME}.js`, { overwrite: true })
}

const configureHandlerFunction = (config: NetlifyConfig) => {
  config.functions[HANDLER_NAME] ||= {}
  config.functions[HANDLER_NAME].included_files ||= []
  config.functions[HANDLER_NAME].included_files.push(`${HANDLER_DIR}/.next/**/*`)

  config.build.environment ||= {}
  config.build.environment.NODE_ENV = 'production'
  config.build.environment.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(
    readJSONSync(`${HANDLER_DIR}/.next/required-server-files.json`).config,
  )
}

const addCatchAllRedirect = (config: NetlifyConfig) => {
  config.redirects ||= []
  config.redirects.push({ from: `/*`, to: HANDLER_URL, status: 200 })
}

export const createHandlerFunction = (publishDir: string, config: NetlifyConfig) => {
  moveServerFiles(publishDir)
  configureHandlerFunction(config)
  addCatchAllRedirect(config)
}
