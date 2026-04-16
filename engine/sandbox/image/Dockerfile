# =============================================================================
# ADLC Sandbox — container efímero para coding agents (MACH Bank stack)
# =============================================================================
# El engine usa docker exec para clonar repos, escribir archivos, instalar
# deps y correr tests mobile dentro de este contenedor. Sin acceso a .env
# del engine, sin acceso a postgres.
#
# Toolchains soportados (stack MACH Bank):
#   - Android → JDK 17 (Temurin) + Gradle 8.7
#   - iOS     → Swift 5.10 Linux toolchain (SwiftPM + swift test, SIN XCTest UI)
#
# Limitación conocida: XCTest de UI requiere macOS/Xcode, no corre en Linux.
# swift build + swift test sí corren para lógica pura / SwiftPM packages.
# =============================================================================

FROM eclipse-temurin:17-jdk-jammy

ARG GRADLE_VERSION=8.7
ARG SWIFT_BRANCH=swift-5.10-release
ARG SWIFT_TAG=swift-5.10-RELEASE

RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates unzip xz-utils \
        binutils gnupg2 libc6-dev libcurl4-openssl-dev \
        libedit2 libgcc-s1 libncurses-dev libpython3-dev \
        libsqlite3-0 libstdc++-11-dev libxml2-dev libz3-dev \
        pkg-config tzdata zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Gradle (binario zip oficial)
# -----------------------------------------------------------------------------
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
        -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
    && rm /tmp/gradle.zip

# -----------------------------------------------------------------------------
# Swift toolchain Linux (swift.org prebuilt)
# Detecta arch en build time: amd64 → x86_64, arm64 → aarch64
# -----------------------------------------------------------------------------
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) SWIFT_PLATFORM_DIR="ubuntu2204";       SWIFT_PKG_SUFFIX="ubuntu22.04" ;; \
        arm64) SWIFT_PLATFORM_DIR="ubuntu2204-aarch64"; SWIFT_PKG_SUFFIX="ubuntu22.04-aarch64" ;; \
        *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    SWIFT_URL="https://download.swift.org/${SWIFT_BRANCH}/${SWIFT_PLATFORM_DIR}/${SWIFT_TAG}/${SWIFT_TAG}-${SWIFT_PKG_SUFFIX}.tar.gz"; \
    echo "fetching ${SWIFT_URL}"; \
    curl -fsSL "${SWIFT_URL}" -o /tmp/swift.tar.gz; \
    mkdir -p /opt/swift; \
    tar xzf /tmp/swift.tar.gz -C /opt/swift --strip-components=1; \
    rm /tmp/swift.tar.gz

ENV PATH="/opt/swift/usr/bin:${PATH}"

# Smoke check de toolchains al build
RUN java -version && gradle --version && swift --version

# /workspace es donde vive cada run. El engine controla su vida.
WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
