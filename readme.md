# 🚀 API Endpoint Executability Validator Agent

Built an intelligent agent to automatically validate API endpoints across apps like Gmail and Google Calendar.

## 🧠 Problem
APIs often include:
- Invalid endpoints
- Missing scopes
- Dependency-based parameters (e.g., messageId)

This agent verifies whether endpoints are actually executable.

## ⚙️ Features
- ✅ Classifies endpoints into:
  - valid
  - invalid_endpoint
  - insufficient_scopes
  - error
- 🔗 Dynamic dependency resolution (e.g., fetch messageId before using it)
- 🧪 Auto-generates minimal valid requests
- ⚡ Works across different APIs (not hardcoded)

## 🏗️ Tech Stack
- TypeScript
- Bun runtime
- Composio SDK

## 📊 Sample Output
```json
{
  "tool_slug": "GMAIL_LIST_MESSAGES",
  "status": "valid",
  "http_status_code": 200
}
