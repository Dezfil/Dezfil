"use client";

import styles from "./Slider.module.css";

/** The app's single-value slider skin. Composed as a
 * class rather than a component: every caller drives the track fill
 * through its own inline custom property and owns its own interaction
 * hook, so wrapping the input would buy nothing and hide the range
 * semantics the keyboard already gets for free. */
export const sliderClass = styles.slider;
