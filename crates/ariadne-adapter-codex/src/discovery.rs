//! Unbound read-only discovery. Runtime owns visibility, lifetime and scheduling.
use crate::{CodexDaemonReader, CodexOptions, DiscoveryPage};
use ariadne_agent_protocol::{AdapterError, EndpointRef};
use std::time::Instant;

pub struct CodexDiscovery {
    options: CodexOptions,
    endpoint: EndpointRef,
    reader: Option<CodexDaemonReader>,
}
impl CodexDiscovery {
    pub fn new(options: CodexOptions, endpoint: EndpointRef) -> Result<Self, AdapterError> {
        options.endpoint_path(&endpoint)?;
        Ok(Self {
            options,
            endpoint,
            reader: None,
        })
    }
    /// Blocking IO; the native runtime offloads this call. Admission supplies one
    /// absolute deadline covering initialization and this page's metadata reads.
    pub fn page(
        &mut self,
        cursor: Option<String>,
        deadline: Instant,
    ) -> Result<DiscoveryPage, AdapterError> {
        if self.reader.is_none() {
            self.reader = Some(CodexDaemonReader::open_before(
                self.options.clone(),
                self.endpoint.clone(),
                deadline,
            )?);
        }
        let result = self
            .reader
            .as_mut()
            .expect("initialized above")
            .discover_before(cursor, deadline);
        if result.is_err() {
            self.reader = None;
        }
        result
    }
}
