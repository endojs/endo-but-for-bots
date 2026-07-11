Name:           endo-gateway
Version:        0.1.0
Release:        1%{?dist}
Summary:        Endo Gateway: HTTP/WebSocket + virtual hosting + OCapN bridge

License:        Apache-2.0
URL:            https://github.com/endojs/endo
Source0:        %{name}-%{version}.tar.gz

BuildArch:      noarch

BuildRequires:  systemd-rpm-macros
BuildRequires:  nodejs >= 22

Requires:       nodejs >= 22
Requires(pre):  shadow-utils
Requires(post): systemd
Requires(preun): systemd
Requires(postun): systemd

Recommends:     git

%description
The Endo Gateway is a long-lived HTTP and WebSocket front-end for the
per-host Endo daemon. It performs virtual hosting for weblet apps,
terminates the OCapN-over-WebSocket transport, and serves Git over
HTTP for object-store-backed repositories.

This package installs the gateway as a systemd-managed service running
as the unprivileged endo:endo system account. See
%{_docdir}/%{name}/system-service.md for the deployment shape and
%{_docdir}/%{name}/packaging.md for the cross-platform upgrade
workflow.

%prep
%setup -q -n %{name}-%{version}

%build
# Node project; no compile step here. Upstream's `yarn build` runs
# during tarball preparation; %build is a no-op.

%install
rm -rf %{buildroot}

# Application payload under /usr/lib/endo-gateway/.
install -d %{buildroot}%{_prefix}/lib/%{name}
cp -a packages/gateway %{buildroot}%{_prefix}/lib/%{name}/

# systemd unit.
install -d %{buildroot}%{_unitdir}
install -m 0644 packages/gateway/systemd/endo-gateway.service \
    %{buildroot}%{_unitdir}/endo-gateway.service

# /etc/sysconfig environment overrides (RHEL/Fedora convention; the
# unit's EnvironmentFile=-/etc/default/endo-gateway path is the
# Debian convention; we ship both as symlinks below in %post).
install -d %{buildroot}%{_sysconfdir}/sysconfig
install -m 0640 packages/gateway/packaging/debian/endo-gateway.default \
    %{buildroot}%{_sysconfdir}/sysconfig/endo-gateway

install -d %{buildroot}%{_sysconfdir}/endo-gateway

# Pre-create the managed directories so SELinux relabeling and per-tree
# attribute ownership land correctly on first install.
install -d -m 0750 %{buildroot}%{_localstatedir}/lib/endo-gateway
install -d -m 0750 %{buildroot}%{_localstatedir}/log/endo-gateway
install -d -m 0750 %{buildroot}%{_localstatedir}/cache/endo-gateway

# Documentation.
install -d %{buildroot}%{_docdir}/%{name}
install -m 0644 packages/gateway/docs/system-service.md \
    %{buildroot}%{_docdir}/%{name}/
install -m 0644 packages/gateway/docs/packaging.md \
    %{buildroot}%{_docdir}/%{name}/

%pre
# Create the endo system group and user. getent is the portable
# probe; useradd is idempotent under -r once the user exists.
getent group endo >/dev/null || groupadd --system endo
getent passwd endo >/dev/null || useradd \
    --system \
    --gid endo \
    --home-dir %{_localstatedir}/lib/endo-gateway \
    --no-create-home \
    --shell /sbin/nologin \
    --comment "Endo Gateway service account" \
    endo
exit 0

%post
%systemd_post endo-gateway.service

%preun
%systemd_preun endo-gateway.service

%postun
%systemd_postun_with_restart endo-gateway.service

%files
%license packages/gateway/LICENSE
%doc %{_docdir}/%{name}/system-service.md
%doc %{_docdir}/%{name}/packaging.md
%dir %{_prefix}/lib/%{name}
%{_prefix}/lib/%{name}/gateway
%{_unitdir}/endo-gateway.service
%config(noreplace) %{_sysconfdir}/sysconfig/endo-gateway
%dir %attr(0755, root, root) %{_sysconfdir}/endo-gateway
%attr(0750, endo, endo) %dir %{_localstatedir}/lib/endo-gateway
%attr(0750, endo, endo) %dir %{_localstatedir}/log/endo-gateway
%attr(0750, endo, endo) %dir %{_localstatedir}/cache/endo-gateway

%changelog
* Thu May 28 2026 Endo contributors <noreply@endojs.org> - 0.1.0-1
- Initial RPM packaging for the Endo Gateway (Feature 10 of #343).
  Installs the systemd unit shipped at
  packages/gateway/systemd/endo-gateway.service.
