use keyring::Entry;
use reqwest::header::AUTHORIZATION;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use thiserror::Error;

use crate::ActiveWorkspaceState;

const LINEAR_GRAPHQL_URL: &str = "https://api.linear.app/graphql";
const KEYRING_SERVICE: &str = "com.andycoupe.orca";

#[derive(Debug, Error)]
enum LinearError {
    #[error("no active workspace")]
    NoActiveWorkspace,
    #[error("Linear is not connected for this workspace")]
    NotConnected,
    #[error("Linear API key is empty")]
    EmptyToken,
    #[error("Linear search query is empty")]
    EmptyQuery,
    #[error("could not access the system credential store: {0}")]
    Keyring(String),
    #[error("Linear rejected the credentials. Reconnect Linear in Workspace settings.")]
    Unauthorized,
    #[error("Linear API rate limit reached; try again later")]
    RateLimited,
    #[error("Linear API request failed with HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("Linear API returned an error: {0}")]
    Graphql(String),
    #[error("Linear API response was not in the expected shape: {0}")]
    Decode(String),
    #[error("network request to Linear failed: {0}")]
    Network(String),
}

impl LinearError {
    fn is_not_found(&self) -> bool {
        matches!(self, LinearError::Graphql(msg) if msg.to_ascii_lowercase().contains("entity not found"))
    }
}

impl From<LinearError> for String {
    fn from(value: LinearError) -> Self {
        value.to_string()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LinearConnectionStatus {
    pub connected: bool,
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinearUser {
    pub id: String,
    pub name: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinearIssueComment {
    pub id: String,
    pub body: String,
    pub user_name: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinearIssue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub url: String,
    pub description: Option<String>,
    pub state: Option<String>,
    pub state_type: Option<String>,
    pub team_key: Option<String>,
    pub team_name: Option<String>,
    pub assignee: Option<String>,
    pub labels: Vec<String>,
    pub comments: Vec<LinearIssueComment>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinearSearchResult {
    pub issues: Vec<LinearIssue>,
}

fn current_workspace_id(active: &State<'_, ActiveWorkspaceState>) -> Result<String, LinearError> {
    let guard = active
        .0
        .lock()
        .map_err(|e| LinearError::Keyring(e.to_string()))?;
    let aw = guard.as_ref().ok_or(LinearError::NoActiveWorkspace)?;
    Ok(aw.id.clone())
}

fn credential_entry(workspace_id: &str) -> Result<Entry, LinearError> {
    Entry::new(KEYRING_SERVICE, &format!("linear:{}", workspace_id))
        .map_err(|e| LinearError::Keyring(e.to_string()))
}

fn load_token(workspace_id: &str) -> Result<String, LinearError> {
    let entry = credential_entry(workspace_id)?;
    entry.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => LinearError::NotConnected,
        other => LinearError::Keyring(other.to_string()),
    })
}

fn store_token(workspace_id: &str, token: &str) -> Result<(), LinearError> {
    credential_entry(workspace_id)?
        .set_password(token)
        .map_err(|e| LinearError::Keyring(e.to_string()))
}

fn delete_token(workspace_id: &str) -> Result<(), LinearError> {
    match credential_entry(workspace_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(LinearError::Keyring(e.to_string())),
    }
}

async fn graphql(token: &str, query: &str, variables: Value) -> Result<Value, LinearError> {
    let client = reqwest::Client::new();
    let resp = client
        .post(LINEAR_GRAPHQL_URL)
        .header(AUTHORIZATION, linear_auth_header(token))
        .json(&json!({
            "query": query,
            "variables": variables,
        }))
        .send()
        .await
        .map_err(|e| LinearError::Network(e.to_string()))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| LinearError::Network(e.to_string()))?;

    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(LinearError::Unauthorized);
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(LinearError::RateLimited);
    }
    if !status.is_success() {
        return Err(LinearError::Http {
            status: status.as_u16(),
            body: body.chars().take(500).collect(),
        });
    }

    let value: Value =
        serde_json::from_str(&body).map_err(|e| LinearError::Decode(e.to_string()))?;
    if let Some(errors) = value.get("errors").and_then(|v| v.as_array()) {
        let msg = errors
            .iter()
            .filter_map(|err| err.get("message").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(LinearError::Graphql(if msg.is_empty() {
            "unknown GraphQL error".to_string()
        } else {
            msg
        }));
    }
    value
        .get("data")
        .cloned()
        .ok_or_else(|| LinearError::Decode("missing data field".to_string()))
}

fn linear_auth_header(token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.starts_with("lin_api_") {
        trimmed.to_string()
    } else {
        format!("Bearer {}", trimmed)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewerData {
    viewer: ViewerNode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewerNode {
    id: String,
    name: Option<String>,
    display_name: Option<String>,
}

async fn fetch_viewer(token: &str) -> Result<LinearUser, LinearError> {
    let data = graphql(
        token,
        r#"
        query OrcaLinearViewer {
          viewer {
            id
            name
            displayName
          }
        }
        "#,
        json!({}),
    )
    .await?;
    let parsed: ViewerData =
        serde_json::from_value(data).map_err(|e| LinearError::Decode(e.to_string()))?;
    Ok(LinearUser {
        id: parsed.viewer.id,
        name: parsed.viewer.name,
        display_name: parsed.viewer.display_name,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssuesData {
    search_issues: IssueSearchConnection,
}

#[derive(Debug, Deserialize)]
struct IssueSearchConnection {
    edges: Vec<IssueSearchEdge>,
}

#[derive(Debug, Deserialize)]
struct IssueSearchEdge {
    node: IssueNode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueNode {
    id: String,
    identifier: String,
    title: String,
    url: String,
    description: Option<String>,
    state: Option<StateNode>,
    team: Option<TeamNode>,
    assignee: Option<UserNode>,
    labels: LabelConnection,
    comments: CommentConnection,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StateNode {
    name: String,
    #[serde(rename = "type")]
    state_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TeamNode {
    key: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserNode {
    name: Option<String>,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LabelConnection {
    nodes: Vec<LabelNode>,
}

#[derive(Debug, Deserialize)]
struct LabelNode {
    name: String,
}

#[derive(Debug, Deserialize)]
struct CommentConnection {
    nodes: Vec<CommentNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentNode {
    id: String,
    body: String,
    user: Option<UserNode>,
    created_at: Option<String>,
}

impl From<IssueNode> for LinearIssue {
    fn from(value: IssueNode) -> Self {
        Self {
            id: value.id,
            identifier: value.identifier,
            title: value.title,
            url: value.url,
            description: value.description,
            state: value.state.as_ref().map(|s| s.name.clone()),
            state_type: value.state.and_then(|s| s.state_type),
            team_key: value.team.as_ref().and_then(|t| t.key.clone()),
            team_name: value.team.and_then(|t| t.name),
            assignee: value
                .assignee
                .and_then(|u| u.display_name.or(u.name))
                .filter(|s| !s.trim().is_empty()),
            labels: value.labels.nodes.into_iter().map(|l| l.name).collect(),
            comments: value
                .comments
                .nodes
                .into_iter()
                .map(|c| LinearIssueComment {
                    id: c.id,
                    body: c.body,
                    user_name: c
                        .user
                        .and_then(|u| u.display_name.or(u.name))
                        .filter(|s| !s.trim().is_empty()),
                    created_at: c.created_at,
                })
                .collect(),
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

async fn search_issues(
    token: &str,
    query: &str,
    limit: u32,
    include_comments: bool,
) -> Result<Vec<LinearIssue>, LinearError> {
    let trimmed = normalize_issue_query(query);
    if trimmed.is_empty() {
        return Err(LinearError::EmptyQuery);
    }
    let limit = limit.clamp(1, 25);
    let comment_limit = if include_comments { 20 } else { 0 };
    let data = graphql(
        token,
        r#"
        query OrcaLinearIssueSearch($query: String!, $first: Int!, $commentFirst: Int!) {
          searchIssues(
            term: $query
            first: $first
            includeArchived: false
          ) {
            edges {
              node {
                id
                identifier
                title
                url
                description
                createdAt
                updatedAt
                state { name type }
                team { key name }
                assignee { name displayName }
                labels { nodes { name } }
                comments(first: $commentFirst) {
                  nodes {
                    id
                    body
                    createdAt
                    user { name displayName }
                  }
                }
              }
            }
          }
        }
        "#,
        json!({
            "query": trimmed,
            "first": limit,
            "commentFirst": comment_limit,
        }),
    )
    .await?;

    let parsed: IssuesData =
        serde_json::from_value(data).map_err(|e| LinearError::Decode(e.to_string()))?;
    Ok(parsed
        .search_issues
        .edges
        .into_iter()
        .map(|edge| LinearIssue::from(edge.node))
        .collect())
}

async fn get_issue_by_id(
    token: &str,
    issue_id: &str,
    include_comments: bool,
) -> Result<Option<LinearIssue>, LinearError> {
    let trimmed = normalize_issue_query(issue_id);
    if trimmed.is_empty() {
        return Err(LinearError::EmptyQuery);
    }
    let comment_limit = if include_comments { 20 } else { 0 };
    let data = graphql(
        token,
        r#"
        query OrcaLinearIssue($id: String!, $commentFirst: Int!) {
          issue(id: $id) {
            id
            identifier
            title
            url
            description
            createdAt
            updatedAt
            state { name type }
            team { key name }
            assignee { name displayName }
            labels { nodes { name } }
            comments(first: $commentFirst) {
              nodes {
                id
                body
                createdAt
                user { name displayName }
              }
            }
          }
        }
        "#,
        json!({
            "id": trimmed,
            "commentFirst": comment_limit,
        }),
    )
    .await?;

    #[derive(Debug, Deserialize)]
    struct IssueData {
        issue: Option<IssueNode>,
    }

    let parsed: IssueData =
        serde_json::from_value(data).map_err(|e| LinearError::Decode(e.to_string()))?;
    Ok(parsed.issue.map(LinearIssue::from))
}

fn normalize_issue_query(query: &str) -> String {
    let trimmed = query.trim();
    if let Some((_, rest)) = trimmed.split_once("/issue/") {
        return rest
            .split('/')
            .next()
            .unwrap_or(rest)
            .split('?')
            .next()
            .unwrap_or(rest)
            .to_string();
    }
    trimmed.to_string()
}

#[tauri::command]
pub fn linear_connection_status(
    active: State<'_, ActiveWorkspaceState>,
) -> Result<LinearConnectionStatus, String> {
    let workspace_id = current_workspace_id(&active)?;
    let connected = match load_token(&workspace_id) {
        Ok(token) => !token.trim().is_empty(),
        Err(LinearError::NotConnected) => false,
        Err(e) => return Err(e.into()),
    };
    Ok(LinearConnectionStatus {
        connected,
        workspace_id,
    })
}

#[tauri::command]
pub async fn linear_save_api_key(
    active: State<'_, ActiveWorkspaceState>,
    api_key: String,
) -> Result<LinearUser, String> {
    let workspace_id = current_workspace_id(&active)?;
    let token = api_key.trim().to_string();
    if token.is_empty() {
        return Err(LinearError::EmptyToken.into());
    }
    let viewer = fetch_viewer(&token).await?;
    store_token(&workspace_id, &token)?;
    Ok(viewer)
}

#[tauri::command]
pub fn linear_disconnect(active: State<'_, ActiveWorkspaceState>) -> Result<(), String> {
    let workspace_id = current_workspace_id(&active)?;
    delete_token(&workspace_id)?;
    Ok(())
}

#[tauri::command]
pub async fn linear_test_connection(
    active: State<'_, ActiveWorkspaceState>,
) -> Result<LinearUser, String> {
    let workspace_id = current_workspace_id(&active)?;
    let token = load_token(&workspace_id)?;
    fetch_viewer(&token).await.map_err(String::from)
}

#[tauri::command]
pub async fn linear_search_issues(
    active: State<'_, ActiveWorkspaceState>,
    query: String,
    limit: Option<u32>,
    include_comments: Option<bool>,
) -> Result<LinearSearchResult, String> {
    let workspace_id = current_workspace_id(&active)?;
    let token = load_token(&workspace_id)?;
    let issues = search_issues(
        &token,
        &query,
        limit.unwrap_or(10),
        include_comments.unwrap_or(true),
    )
    .await?;
    Ok(LinearSearchResult { issues })
}

#[tauri::command]
pub async fn linear_get_issue(
    active: State<'_, ActiveWorkspaceState>,
    issue_id: String,
    include_comments: Option<bool>,
) -> Result<Option<LinearIssue>, String> {
    let workspace_id = current_workspace_id(&active)?;
    let token = load_token(&workspace_id)?;
    match get_issue_by_id(&token, &issue_id, include_comments.unwrap_or(true)).await {
        Ok(issue) => Ok(issue),
        Err(err) if err.is_not_found() => Ok(None),
        Err(err) => Err(err.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{linear_auth_header, normalize_issue_query};

    #[test]
    fn linear_auth_header_uses_raw_personal_api_key() {
        assert_eq!(linear_auth_header(" lin_api_123 "), "lin_api_123");
    }

    #[test]
    fn linear_auth_header_uses_bearer_for_oauth_tokens() {
        assert_eq!(linear_auth_header("oauth-token"), "Bearer oauth-token");
    }

    #[test]
    fn graphql_entity_not_found_is_detected_for_search_fallback() {
        let err = super::LinearError::Graphql("Entity not found: Issue".to_string());
        assert!(err.is_not_found());
    }

    #[test]
    fn normalize_issue_query_extracts_identifier_from_url() {
        assert_eq!(
            normalize_issue_query("https://linear.app/acme/issue/ENG-123/fix-login"),
            "ENG-123"
        );
        assert_eq!(
            normalize_issue_query("https://linear.app/acme/issue/ENG-123?foo=bar"),
            "ENG-123"
        );
    }

    #[test]
    fn normalize_issue_query_keeps_plain_search_text() {
        assert_eq!(normalize_issue_query("  login polish  "), "login polish");
    }
}
