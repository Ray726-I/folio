//! Renderer client IDs are local to a trusted workspace window. The offline
//! renderer sees fresh native IDs, so one window can never collide with or
//! cancel another window's request.
use std::collections::HashMap;
#[derive(Default)]
pub struct Routes {
    next: u64,
    entries: HashMap<String, (String, String)>,
    clients: HashMap<(String, String), String>,
}
fn valid_client(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
impl Routes {
    pub fn record(&mut self, window: &str, client: &str) -> Result<String, String> {
        if !valid_client(client) {
            return Err("Invalid diagram request ID.".into());
        }
        let key = (window.to_string(), client.to_string());
        if self.clients.contains_key(&key) {
            return Err("A diagram request with this ID is already pending.".into());
        }
        self.next = self
            .next
            .checked_add(1)
            .ok_or("The diagram request counter was exhausted.")?;
        let native = format!("render-{}", self.next);
        self.entries.insert(native.clone(), key.clone());
        self.clients.insert(key, native.clone());
        Ok(native)
    }
    pub fn find(&self, window: &str, client: &str) -> Result<Option<String>, String> {
        if !valid_client(client) {
            return Err("Invalid diagram request ID.".into());
        }
        Ok(self
            .clients
            .get(&(window.to_string(), client.to_string()))
            .cloned())
    }
    pub fn remove(&mut self, native: &str) -> Option<(String, String)> {
        let route = self.entries.remove(native)?;
        self.clients.remove(&route);
        Some(route)
    }
    pub fn take_window(&mut self, window: &str) -> Vec<String> {
        let ids: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, route)| route.0 == window)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            self.remove(id);
        }
        ids
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_client_ids_are_independent_between_windows() {
        let mut routes = Routes::default();
        let a = routes.record("main", "m1").unwrap();
        let b = routes.record("workspace-1", "m1").unwrap();
        assert_ne!(a, b);
        assert!(routes.record("main", "m1").is_err());
        assert_eq!(routes.find("workspace-1", "m1").unwrap(), Some(b.clone()));
        assert_eq!(routes.remove(&a), Some(("main".into(), "m1".into())));
        assert_eq!(routes.find("workspace-1", "m1").unwrap(), Some(b));
    }
    #[test]
    fn closing_a_window_removes_only_its_own_routes() {
        let mut routes = Routes::default();
        let a = routes.record("main", "m1").unwrap();
        let b = routes.record("workspace-1", "m1").unwrap();
        assert_eq!(routes.take_window("main"), vec![a]);
        assert_eq!(routes.find("main", "m1").unwrap(), None);
        assert_eq!(routes.remove(&b), Some(("workspace-1".into(), "m1".into())));
        assert!(routes.find("main", "../invalid").is_err());
    }
}
