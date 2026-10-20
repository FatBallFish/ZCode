# Image Search for Mikiko

[中文文档](./README_CN.md)

This Mikiko plugin currently uses the official CodingPlan image search MCP backend, so the agent can look up
illustrations and reference images while producing documents, slides, posters, or web pages.

## Components

- MCP server `image_search` (HTTP), namespaced as `plugin:image-search:image_search`.

## Requirements

- A Mikiko session signed in to a current Zhipu BigModel or Z.ai account. The official CodingPlan backend checks account entitlement and quota; no manual token or API key is needed.
- Network access to the official CodingPlan endpoint. Mikiko product cloud settings do not change this account destination.
- Start a new Mikiko session after installing or updating the plugin.

## Usage

Once installed, ask for images in natural language — for example "find a photo of a wind farm for
the cover" — and the agent calls the image search tool. It pairs well with the `documents`, `pdf`,
and `presentations` plugins, which no longer bundle this MCP server: install this plugin alongside
them when you want image search available during document production.

## Notes

- The plugin only declares an MCP server; it ships no commands, skills, hooks, or agents.
- Calls fail explicitly when the account is unavailable; paid search is never sent anonymously.
- A custom backend port is reserved for future implementations and does not inherit official account authentication.
- Search results come from a third-party image index through the CodingPlan service. Check the license of
  any image before using it in a published deliverable.
