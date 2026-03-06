/**
 * Rune landing page — interactions & animations
 */

// ── Scroll-reveal: fade in sections as they enter the viewport ──
document.addEventListener('DOMContentLoaded', () => {
    const observer = new IntersectionObserver(
        (entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible')
                    observer.unobserve(entry.target)
                }
            })
        },
        { threshold: 0.1 }
    )

    // Observe all major sections and feature cards
    document.querySelectorAll(
        '.feature-card, .step, .explanation-card, .graph-container, .table-wrapper, .cta-section h2, .cta-buttons'
    ).forEach(el => {
        el.classList.add('reveal')
        observer.observe(el)
    })

    // ── Graph node animation: light up nodes in sequence ──
    const nodes = document.querySelectorAll('.graph-node')
    const result = document.getElementById('graph-result')

    function animateGraph() {
        // Reset
        nodes.forEach(n => n.classList.remove('active'))
        if (result) result.style.opacity = '0'

        nodes.forEach((node, i) => {
            setTimeout(() => {
                node.classList.add('active')
                if (i === nodes.length - 1 && result) {
                    setTimeout(() => {
                        result.style.opacity = '1'
                    }, 300)
                }
            }, i * 400)
        })
    }

    // Animate graph when it enters viewport
    const graphContainer = document.querySelector('.graph-container')
    if (graphContainer) {
        const graphObserver = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        animateGraph()
                        // Re-animate every 6 seconds while visible
                        setInterval(animateGraph, 6000)
                        graphObserver.unobserve(entry.target)
                    }
                })
            },
            { threshold: 0.3 }
        )
        graphObserver.observe(graphContainer)
    }

    // ── Nav background on scroll ──
    const nav = document.getElementById('nav')
    if (nav) {
        window.addEventListener('scroll', () => {
            nav.classList.toggle('scrolled', window.scrollY > 50)
        }, { passive: true })
    }

    // ── Smooth scroll for anchor links ──
    document.querySelectorAll('a[href^="#"]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault()
            const target = document.querySelector(link.getAttribute('href'))
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
        })
    })
})

// ── Inject reveal animation styles ──
const style = document.createElement('style')
style.textContent = `
    .reveal {
        opacity: 0;
        transform: translateY(20px);
        transition: opacity 0.5s ease, transform 0.5s ease;
    }
    .reveal.visible {
        opacity: 1;
        transform: translateY(0);
    }
    .feature-card.reveal:nth-child(2) { transition-delay: 0.08s; }
    .feature-card.reveal:nth-child(3) { transition-delay: 0.16s; }
    .feature-card.reveal:nth-child(4) { transition-delay: 0.24s; }
    .feature-card.reveal:nth-child(5) { transition-delay: 0.32s; }
    .feature-card.reveal:nth-child(6) { transition-delay: 0.40s; }
    .step.reveal:nth-child(2) { transition-delay: 0.08s; }
    .step.reveal:nth-child(3) { transition-delay: 0.16s; }
    .step.reveal:nth-child(4) { transition-delay: 0.24s; }
    .step.reveal:nth-child(5) { transition-delay: 0.32s; }
    .nav.scrolled { background: rgba(7, 7, 15, 0.95); }
    #graph-result { transition: opacity 0.4s ease; }
`
document.head.appendChild(style)
